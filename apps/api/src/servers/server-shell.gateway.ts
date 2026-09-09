import type { IncomingMessage } from 'node:http';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection } from '@nestjs/websockets';
import { Logger } from '@pkg/server';
import { SecretsService, SshService, type ShellHandle } from '@pkg/server';
import type { WebSocket } from 'ws';
import { ServerShellRepository } from './server-shell.repository.js';
import { SHELL_IDLE_MS, ServerShellService, capTranscript } from './server-shell.service.js';

/** Browser → server. Keystrokes are raw binary; control messages are small JSON. */
interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

/**
 * The interactive shell socket.
 *
 * Authentication happened over HTTP: `POST /servers/:id/shell` ran behind the
 * ordinary guard chain and minted a single-use ticket, which this connection
 * redeems. Nothing here re-derives identity, because Nest applies `@UseGuards`
 * on a gateway per MESSAGE rather than per connection — a guard would leave
 * the connection itself unprotected, and hand-rolling the JWT/blacklist checks
 * would be a second copy of the auth stack to keep in sync.
 *
 * Bytes both ways are raw binary. JSON or base64 framing would inflate every
 * keystroke and every screenful of output by a third for no benefit.
 */
@WebSocketGateway({ path: '/api/servers/shell' })
export class ServerShellGateway implements OnGatewayConnection {
  constructor(
    private readonly shells: ServerShellService,
    private readonly repo: ServerShellRepository,
    private readonly ssh: SshService,
    private readonly secrets: SecretsService,
    private readonly logger: Logger,
  ) {}

  async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const ticket = new URL(request.url ?? '', 'http://localhost').searchParams.get('ticket');
    const claim = ticket ? this.shells.redeem(ticket) : null;
    if (!claim) {
      // Deliberately unspecific: an unknown, expired and already-redeemed
      // ticket are indistinguishable from outside.
      socket.close(4401, 'unauthorized');
      return;
    }

    const server = await this.repo.findServer(claim.serverId, claim.orgId);
    if (!server) {
      socket.close(4404, 'server gone');
      return;
    }

    let transcript = '';
    let bytesIn = 0;
    let bytesOut = 0;
    let shell: ShellHandle | null = null;
    let ended = false;

    // Every exit path lands here, and several can fire at once — the user
    // closes the tab while the window lapses while the far end exits.
    const end = async (outcome: Parameters<ServerShellService['finish']>[0]['outcome'], detail?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      shell?.close();
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      await this.shells.finish({
        sessionId: claim.sessionId,
        outcome,
        detail,
        transcript: capTranscript(transcript),
        bytesIn,
        bytesOut,
      });
    };

    // The hard expiry is recorded on the row at issue time, so it is the same
    // deadline the UI counts down to.
    const hardTimer = setTimeout(
      () => void end('expired'),
      Math.max(claim.expiresAt.getTime() - Date.now(), 0),
    );
    hardTimer.unref();

    let idleTimer = setTimeout(() => void end('idle'), SHELL_IDLE_MS);
    idleTimer.unref();
    const touch = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void end('idle'), SHELL_IDLE_MS);
      idleTimer.unref();
    };

    // Attach the message listener BEFORE connecting out.
    //
    // The client sends its resize the moment the WebSocket opens, which is as
    // soon as the HTTP upgrade completes — several hundred milliseconds before
    // the SSH connection is up. Listening only after `await ssh.shell(...)`
    // silently drops it, and the pty stays at its 80x24 default while the
    // browser believes it is 123 columns wide. Everything full-screen then
    // renders to the wrong box, which is the single most common way a web
    // terminal ships broken.
    let pendingSize: { cols: number; rows: number } | null = null;
    const pendingInput: Buffer[] = [];

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      touch();
      if (!isBinary) {
        try {
          const msg = JSON.parse(raw.toString('utf8')) as ResizeMessage;
          if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            const size = { cols: Math.max(1, msg.cols | 0), rows: Math.max(1, msg.rows | 0) };
            if (shell) shell.resize(size);
            else pendingSize = size;
          }
        } catch {
          /* not a control message; ignore rather than kill the session */
        }
        return;
      }
      bytesIn += raw.byteLength;
      if (shell) shell.write(raw);
      else pendingInput.push(raw);
    });

    socket.on('close', () => void end('closed'));
    socket.on('error', (error: Error) => void end('error', error.message));

    try {
      shell = await this.ssh.shell(
        {
          host: server.host,
          port: server.port,
          user: server.sshUser,
          privateKey: this.secrets.open(server.privateKeyEnc),
          hostFingerprint: server.hostFingerprint,
        },
        { cols: 80, rows: 24 },
        {
          onData: (chunk) => {
            bytesOut += chunk.byteLength;
            transcript += chunk.toString('utf8');
            // Cap as we go: a runaway `yes` should not grow the heap for
            // half an hour before capTranscript trims it at the end.
            if (transcript.length > 2 * 1024 * 1024) transcript = capTranscript(transcript);
            if (socket.readyState === socket.OPEN) socket.send(chunk);
          },
          onClose: (code) => void end('closed', code === null ? undefined : `exit ${code}`),
          onError: (error) => void end('error', error.message),
        },
      );
    } catch (error) {
      this.logger.warn(`shell connect failed: ${(error as Error).message}`, 'ServerShellGateway');
      await end('error', (error as Error).message);
      return;
    }

    this.shells.register({
      sessionId: claim.sessionId,
      orgId: claim.orgId,
      serverId: claim.serverId,
      expiresAt: claim.expiresAt,
      close: (outcome, detail) => end(outcome, detail),
    });

    // Whatever arrived while the connection was being made.
    if (pendingSize) shell.resize(pendingSize);
    for (const chunk of pendingInput) shell.write(chunk);
    pendingInput.length = 0;
  }
}
