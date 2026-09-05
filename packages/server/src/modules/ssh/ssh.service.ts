import { Injectable } from '@nestjs/common';
import { Client, type ConnectConfig } from 'ssh2';
import { createHash } from 'node:crypto';
import { REMOTE_OPS, type RemoteOp } from './remote-ops.js';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** OpenSSH-format private key (already unsealed by the caller). */
  privateKey: string;
  /** Pinned host key fingerprint (SHA256:base64); null on first contact. */
  hostFingerprint: string | null;
}

export interface SshCheckResult {
  ok: boolean;
  /** SHA256 fingerprint observed on this connection. */
  fingerprint: string | null;
  /** Set when ok=false: 'fingerprint_mismatch' | 'unreachable'. */
  reason?: 'fingerprint_mismatch' | 'unreachable';
  detail?: string;
}

export type { RemoteOp } from './remote-ops.js';

/**
 * Agentless SSH seam (the deliberate non-goal is a remote daemon — targets
 * need nothing but sshd and docker). Two invariants:
 * - Host keys are pinned on first successful contact; any later change is a
 *   hard failure, never silently accepted (MITM protection).
 * - Only NAMED idempotent scripts from remote-ops/ run remotely — ad-hoc
 *   command strings never cross the wire.
 * Callers hold the unsealed key only for the duration of the call; this
 * service never stores anything.
 */
@Injectable()
export class SshService {
  private connect(target: SshTarget): Promise<{ client: Client; fingerprint: string }> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let fingerprint = '';
      const config: ConnectConfig = {
        host: target.host,
        port: target.port,
        username: target.user,
        privateKey: target.privateKey,
        readyTimeout: 10_000,
        hostVerifier: (key: Buffer) => {
          fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
          // Pin-on-first-use: accept unknown hosts once, then hold the pin.
          return target.hostFingerprint === null || target.hostFingerprint === fingerprint;
        },
      };
      client
        .on('ready', () => resolve({ client, fingerprint }))
        .on('error', (err) => reject(Object.assign(err, { observedFingerprint: fingerprint })))
        .connect(config);
    });
  }

  /** Reachability + host-key check; never throws — the result says why. */
  async testConnection(target: SshTarget): Promise<SshCheckResult> {
    try {
      const { client, fingerprint } = await this.connect(target);
      client.end();
      return { ok: true, fingerprint };
    } catch (error) {
      const observed = (error as { observedFingerprint?: string }).observedFingerprint || null;
      const mismatch =
        observed !== null && target.hostFingerprint !== null && observed !== target.hostFingerprint;
      return {
        ok: false,
        fingerprint: observed,
        reason: mismatch ? 'fingerprint_mismatch' : 'unreachable',
        detail: (error as Error).message,
      };
    }
  }

  /**
   * Run a named remote-op, streaming `stdin` to it. Throws on non-zero exit.
   * `onOutput` (optional) receives every stdout/stderr chunk AS IT ARRIVES —
   * how deployment logs show a build's progress while it is still running.
   */
  async exec(
    target: SshTarget,
    op: RemoteOp,
    args: string[] = [],
    stdin = '',
    onOutput?: (chunk: string) => void,
  ): Promise<string> {
    const script = REMOTE_OPS[op];
    const { client } = await this.connect(target);
    try {
      return await new Promise<string>((resolve, reject) => {
        const quoted = args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
        client.exec(`bash -s -- ${quoted}`, (err, stream) => {
          if (err) return reject(err);
          let out = '';
          let errOut = '';
          stream
            .on('data', (d: Buffer) => {
              out += d.toString();
              onOutput?.(d.toString());
            })
            .on('close', (code: number) =>
              code === 0
                ? resolve(out)
                : reject(new Error(`remote-op ${op} exited ${code}: ${errOut || out}`)),
            );
          stream.stderr.on('data', (d: Buffer) => {
            errOut += d.toString();
            onOutput?.(d.toString());
          });
          // No separator: scripts are newline-terminated, and an extra blank
          // line would be consumed by the script's first data `read`.
          stream.end(script.endsWith('\n') ? script + stdin : script + '\n' + stdin);
        });
      });
    } finally {
      client.end();
    }
  }

  /**
   * Stream a named op's stdout on `source` into a named op's stdin on
   * `dest` — the registry-less image transport (docker save | ssh | load).
   * Binary-safe: the bytes never land on the worker's disk or in a string.
   */
  async pipeOp(
    source: SshTarget,
    sourceOp: RemoteOp,
    sourceArgs: string[],
    dest: SshTarget,
    destOp: RemoteOp,
  ): Promise<void> {
    const quoted = (args: string[]) => args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
    const { client: src } = await this.connect(source);
    try {
      const { client: dst } = await this.connect(dest);
      try {
        await new Promise<void>((resolve, reject) => {
          dst.exec(`bash -s`, (destErr, destStream) => {
            if (destErr) return reject(destErr);
            let destErrOut = '';
            destStream.stderr.on('data', (d: Buffer) => (destErrOut += d.toString()));
            destStream.on('close', (code: number) =>
              code === 0
                ? resolve()
                : reject(new Error(`remote-op ${destOp} exited ${code}: ${destErrOut}`)),
            );
            // Scripts are newline-terminated; adding one would prepend a stray
            // byte to the binary payload docker load reads.
            destStream.write(REMOTE_OPS[destOp]);
            src.exec(`bash -s -- ${quoted(sourceArgs)}`, (srcErr, srcStream) => {
              if (srcErr) return reject(srcErr);
              let srcErrOut = '';
              srcStream.stderr.on('data', (d: Buffer) => (srcErrOut += d.toString()));
              srcStream.on('close', (code: number) => {
                if (code !== 0) {
                  reject(new Error(`remote-op ${sourceOp} exited ${code}: ${srcErrOut}`));
                }
                destStream.end();
              });
              srcStream.write(REMOTE_OPS[sourceOp]);
              srcStream.pipe(destStream, { end: false });
            });
          });
        });
      } finally {
        dst.end();
      }
    } finally {
      src.end();
    }
  }

  /** SFTP a file with owner-only permissions (env files, rendered configs). */
  async writeFile(target: SshTarget, remotePath: string, content: string): Promise<void> {
    const { client } = await this.connect(target);
    try {
      await new Promise<void>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err);
          const stream = sftp.createWriteStream(remotePath, { mode: 0o600 });
          stream.on('error', reject).on('close', () => resolve());
          stream.end(content);
        });
      });
    } finally {
      client.end();
    }
  }
}
