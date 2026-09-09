import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SHELL_SESSION_IDLE_MS,
  SHELL_SESSION_MAX_CONCURRENT,
  SHELL_SESSION_TTL_MS,
  SHELL_TRANSCRIPT_MAX_BYTES,
  type ActiveUser,
  type ShellSessionOutcome,
} from '@pkg/contracts';
import { k } from '@pkg/locales';
import { ServerShellRepository } from './server-shell.repository.js';

/**
 * A ticket that has been issued but not yet redeemed by a socket. It is the
 * whole authentication story for the WebSocket.
 *
 * The socket does NOT re-derive identity from cookies. The REST route that
 * mints this ran behind the ordinary guard chain — Auth → ActiveOrg → Roles →
 * Permissions — so authorization has already happened over HTTP, where those
 * guards actually apply. Nest runs `@UseGuards` on a gateway per MESSAGE, not
 * per connection, so authenticating on the socket would mean either
 * reimplementing the guard chain by hand or leaving the connection itself
 * unguarded. A single-use ticket avoids both.
 */
interface PendingTicket {
  sessionId: string;
  serverId: string;
  orgId: string;
  userId: string;
  expiresAt: Date;
}

/** A socket that has redeemed its ticket and holds a live pty. */
export interface LiveShell {
  sessionId: string;
  orgId: string;
  serverId: string;
  expiresAt: Date;
  close: (outcome: ShellSessionOutcome, detail?: string) => Promise<void>;
}

/**
 * Issues, redeems and reaps browser shell sessions.
 *
 * State is in-process on purpose: a ticket lives for seconds and a session is
 * bound to one socket on one instance, so replicating it would buy nothing.
 * specbook runs a single api container; if that ever changes, tickets and the
 * live-session registry are the two things that must move to Redis, and a
 * second instance would otherwise reject a socket whose ticket it never issued.
 */
@Injectable()
export class ServerShellService {
  /** Redeemable for ~30s — long enough to open a socket, short enough to be uninteresting if leaked. */
  private static readonly TICKET_TTL_MS = 30_000;

  private readonly tickets = new Map<string, PendingTicket>();
  private readonly live = new Map<string, LiveShell>();

  constructor(private readonly repo: ServerShellRepository) {}

  /**
   * Called from the REST route, behind `@Permissions('server:shell')`.
   * Writes the audit row FIRST: a session that is refused, or that dies before
   * a socket ever attaches, still has to appear in the trail.
   */
  async issue(
    user: ActiveUser,
    serverId: string,
  ): Promise<{ sessionId: string; ticket: string; expiresAt: Date }> {
    const server = await this.repo.findServer(serverId, user.orgId);
    if (!server) throw new NotFoundException(k.servers.errors.notFound);

    if (this.countOpenFor(user.orgId) >= SHELL_SESSION_MAX_CONCURRENT) {
      await this.repo.record({
        orgId: user.orgId,
        serverId: server.id,
        serverName: server.name,
        serverHost: server.host,
        userId: user.userId,
        outcome: 'refused',
        detail: k.servers.errors.shellTooManySessions,
        expiresAt: new Date(),
      });
      throw new BadRequestException(k.servers.errors.shellTooManySessions);
    }

    const expiresAt = new Date(Date.now() + SHELL_SESSION_TTL_MS);
    const sessionId = await this.repo.record({
      orgId: user.orgId,
      serverId: server.id,
      serverName: server.name,
      serverHost: server.host,
      userId: user.userId,
      outcome: 'open',
      expiresAt,
    });

    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      sessionId,
      serverId: server.id,
      orgId: user.orgId,
      userId: user.userId,
      expiresAt,
    });
    // An unredeemed ticket must not linger — and neither must its row. A
    // session that is issued and never connected (the tab was closed, the
    // socket never opened) would otherwise sit at `open` in the audit forever,
    // which makes the trail lie about what is currently live.
    setTimeout(() => {
      if (!this.tickets.delete(ticket)) return; // redeemed; the socket owns it now
      void this.repo
        .close({
          sessionId,
          outcome: 'expired',
          detail: 'ticket was never redeemed',
          transcript: '',
          bytesIn: 0,
          bytesOut: 0,
        })
        .catch(() => undefined);
    }, ServerShellService.TICKET_TTL_MS).unref();

    return { sessionId, ticket, expiresAt };
  }

  /** Single use: redeeming removes it, so a replayed ticket is simply unknown. */
  redeem(ticket: string): PendingTicket | null {
    const found = this.tickets.get(ticket);
    if (!found) return null;
    this.tickets.delete(ticket);
    if (found.expiresAt.getTime() <= Date.now()) return null;
    return found;
  }

  register(shell: LiveShell): void {
    this.live.set(shell.sessionId, shell);
  }

  unregister(sessionId: string): void {
    this.live.delete(sessionId);
  }

  private countOpenFor(orgId: string): number {
    let n = 0;
    for (const s of this.live.values()) if (s.orgId === orgId) n++;
    return n;
  }

  /**
   * Close out the audit row. Called from the socket on every exit path — the
   * user closing the tab, the window lapsing, the far end dying — so it must
   * tolerate being called twice.
   */
  async finish(args: {
    sessionId: string;
    outcome: ShellSessionOutcome;
    detail?: string;
    transcript: string;
    bytesIn: number;
    bytesOut: number;
  }): Promise<void> {
    this.live.delete(args.sessionId);
    await this.repo.close(args);
  }
}

/**
 * Keeps the newest output within the cap. A shell can print without bound (a
 * log tail, `yes`), and the audit row is not the place to discover that. The
 * drop is marked in-band so the record never quietly claims to be complete.
 */
export function capTranscript(text: string, max = SHELL_TRANSCRIPT_MAX_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= max) return text;
  const notice = `… [transcript truncated: ${buf.byteLength - max} earlier bytes dropped]\n`;
  return notice + buf.subarray(buf.byteLength - max).toString('utf8');
}

/** Idle timeout is separate from the hard expiry: both have to be able to end a session. */
export const SHELL_IDLE_MS = SHELL_SESSION_IDLE_MS;
