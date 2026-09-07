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
/**
 * No bytes at all for this long means the far end is gone. Deliberately keyed
 * on PROGRESS, not wall-clock: a 2 GB image over a poor link is slow, and slow
 * must not be treated as broken.
 */
const PIPE_STALL_MS = 120_000;

/** Ceiling on one transfer, so an unforeseen stall cannot park a deploy forever. */
const PIPE_MAX_MS = 45 * 60_000;

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
        // Without these a connection that dies mid-transfer is never noticed:
        // the stream simply stops producing bytes and the far end waits on it
        // forever. That is not hypothetical — a stalled image transfer parked a
        // deploy indefinitely, with `docker load` blocked on stdin that would
        // never arrive. Three missed keepalives is ~30s to detect a dead peer,
        // which matters most here because the build box sits behind NAT and
        // conntrack drops a flow long before TCP would.
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
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
    /**
     * Aborting ends the REMOTE command, not just this promise. A caller that
     * merely stopped awaiting would leave a build or an image load running on
     * someone else's machine with nothing left to reap it.
     */
    signal?: AbortSignal,
  ): Promise<string> {
    const script = REMOTE_OPS[op];
    if (signal?.aborted) throw new Error('aborted');
    const { client } = await this.connect(target);
    try {
      return await new Promise<string>((resolve, reject) => {
        const onAbort = (): void => {
          client.end();
          reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
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
  /**
   * Stream one remote op's stdout into another host's stdin — used to move a
   * built image from the build server to the app server without it ever
   * touching disk here.
   *
   * The failure this guards against is not a slow transfer, it is a SILENT
   * one. If the source connection dies mid-stream the stream simply stops
   * producing bytes: no `close`, no error worth the name, and the destination
   * sits on `docker load` waiting for stdin that will never arrive. A deploy
   * parked that way never fails, never retries, and never tells anyone.
   *
   * So three things are true here that were not before: both connections are
   * watched for death (see `keepaliveInterval` in connect), a stall with no
   * bytes at all is fatal, and the whole transfer has a ceiling.
   */
  async pipeOp(
    source: SshTarget,
    sourceOp: RemoteOp,
    sourceArgs: string[],
    dest: SshTarget,
    destOp: RemoteOp,
    /** Ends both remote commands, not just the wait — see exec. */
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    const quoted = (args: string[]) => args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
    const { client: src } = await this.connect(source);
    try {
      const { client: dst } = await this.connect(dest);
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(overall);
            clearInterval(stallCheck);
            err ? reject(err) : resolve();
          };

          // A transfer that produces NO bytes for this long is dead. Keyed on
          // progress rather than wall-clock so a genuinely slow link is fine —
          // a 2 GB image over a poor connection is slow, not stalled.
          let moved = 0;
          let seenAtLastCheck = -1;
          const stallCheck = setInterval(() => {
            if (moved === seenAtLastCheck) {
              finish(
                new Error(
                  `transfer stalled: no data for ${PIPE_STALL_MS / 1000}s after ${moved} bytes`,
                ),
              );
              return;
            }
            seenAtLastCheck = moved;
          }, PIPE_STALL_MS);

          const overall = setTimeout(
            () => finish(new Error(`transfer exceeded ${PIPE_MAX_MS / 60_000}m (${moved} bytes)`)),
            PIPE_MAX_MS,
          );

          // Post-`ready` connection failures used to reject an already-settled
          // promise inside connect(), which is a no-op — so a dropped link was
          // swallowed whole. They land here now.
          src.on('error', (e: Error) => finish(new Error(`source connection failed: ${e.message}`)));
          dst.on('error', (e: Error) => finish(new Error(`dest connection failed: ${e.message}`)));
          // Ending both clients stops `docker save` and `docker load` on the
          // remote boxes; without that a cancel would abandon a running load.
          signal?.addEventListener(
            'abort',
            () => {
              src.end();
              dst.end();
              finish(new Error('aborted'));
            },
            { once: true },
          );

          dst.exec(`bash -s`, (destErr, destStream) => {
            if (destErr) return finish(destErr);
            let destErrOut = '';
            destStream.stderr.on('data', (d: Buffer) => (destErrOut += d.toString()));
            destStream.on('close', (code: number) =>
              finish(
                code === 0
                  ? undefined
                  : new Error(`remote-op ${destOp} exited ${code}: ${destErrOut}`),
              ),
            );
            // Scripts are newline-terminated; adding one would prepend a stray
            // byte to the binary payload docker load reads.
            destStream.write(REMOTE_OPS[destOp]);
            src.exec(`bash -s -- ${quoted(sourceArgs)}`, (srcErr, srcStream) => {
              if (srcErr) return finish(srcErr);
              let srcErrOut = '';
              srcStream.stderr.on('data', (d: Buffer) => (srcErrOut += d.toString()));
              srcStream.on('data', (d: Buffer) => (moved += d.length));
              srcStream.on('close', (code: number) => {
                if (code !== 0) {
                  finish(new Error(`remote-op ${sourceOp} exited ${code}: ${srcErrOut}`));
                  return;
                }
                // Clean source exit: let the destination drain and close on its
                // own terms, which is what reports success.
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
