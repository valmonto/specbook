import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  and,
  desc,
  eq,
  server,
  serverShellSession,
  user as userTable,
  type ServerShellSession,
} from '@pkg/database';
import type { ShellSessionOutcome } from '@pkg/contracts';

/**
 * The shell audit trail. Org-scoped like every other repository here, and
 * append-mostly: a row is written when a session is opened or refused and
 * closed out in place when it ends. Nothing else touches these rows.
 */
@Injectable()
export class ServerShellRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  /** Org-scoped: a shell can only ever be opened on this org's own server. */
  async findServer(serverId: string, orgId: string) {
    const [row] = await this.dbClient.db
      .select()
      .from(server)
      .where(and(eq(server.id, serverId), eq(server.orgId, orgId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Writes the opening (or refusal) row and returns its id.
   *
   * The user's name and email are snapshotted alongside the server's, so the
   * trail still answers "who had a shell where" after the account or the
   * server row is gone.
   */
  async record(args: {
    orgId: string;
    serverId: string;
    serverName: string;
    serverHost: string;
    userId: string;
    outcome: ShellSessionOutcome;
    detail?: string;
    expiresAt: Date;
  }): Promise<string> {
    const [u] = await this.dbClient.db
      .select({ name: userTable.name, email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, args.userId))
      .limit(1);

    const [row] = await this.dbClient.db
      .insert(serverShellSession)
      .values({
        orgId: args.orgId,
        serverId: args.serverId,
        serverName: args.serverName,
        serverHost: args.serverHost,
        userId: args.userId,
        userName: u?.name ?? 'unknown',
        userEmail: u?.email ?? 'unknown',
        outcome: args.outcome,
        detail: args.detail ?? null,
        expiresAt: args.expiresAt,
      })
      .returning({ id: serverShellSession.id });
    return row!.id;
  }

  /** Closes a session out. Idempotent by construction — writing the same end twice is harmless. */
  async close(args: {
    sessionId: string;
    outcome: ShellSessionOutcome;
    detail?: string;
    transcript: string;
    bytesIn: number;
    bytesOut: number;
  }): Promise<void> {
    await this.dbClient.db
      .update(serverShellSession)
      .set({
        outcome: args.outcome,
        detail: args.detail ?? null,
        transcript: args.transcript,
        bytesIn: args.bytesIn,
        bytesOut: args.bytesOut,
        endedAt: new Date(),
      })
      .where(eq(serverShellSession.id, args.sessionId));
  }

  /** The audit view for one server, newest first. */
  async listForServer(
    serverId: string,
    orgId: string,
    limit = 50,
  ): Promise<ServerShellSession[]> {
    return this.dbClient.db
      .select()
      .from(serverShellSession)
      .where(and(eq(serverShellSession.serverId, serverId), eq(serverShellSession.orgId, orgId)))
      .orderBy(desc(serverShellSession.openedAt))
      .limit(limit);
  }
}
