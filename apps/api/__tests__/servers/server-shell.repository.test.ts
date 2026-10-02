import {
  createDatabaseClient,
  eq,
  organization,
  organizationUser,
  server,
  serverShellSession,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ServerShellRepository } from '@/servers/server-shell.repository.js';

/**
 * The tenancy boundary on the shell audit trail, proven against the real
 * database.
 *
 * `extendExpiry` is the write that matters here: it moves when an audited
 * session is allowed to end, so one org being able to move another's — or to
 * move a session that has already been closed out — would let the record
 * disagree with what actually happened.
 */
describeIntegration('ServerShellRepository — two-tenant boundary', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new ServerShellRepository(client);

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let serverA: string;

  async function makeOrg(name: string) {
    const [owner] = await client.db
      .insert(user)
      .values({ email: `${name}@example.com`, name, passwordHash: 'x' })
      .returning();
    const [org] = await client.db
      .insert(organization)
      .values({ name, ownerId: owner!.id })
      .returning();
    await client.db
      .insert(organizationUser)
      .values({ orgId: org!.id, userId: owner!.id, role: 'OWNER' });
    return { orgId: org!.id, ownerId: owner!.id };
  }

  async function makeServer(orgId: string, createdBy: string) {
    const [row] = await client.db
      .insert(server)
      .values({
        orgId,
        name: 'box-1',
        host: 'example.com',
        roles: ['app'],
        publicKey: 'ssh-ed25519 AAAA test',
        privateKeyEnc: 'v1:sealed',
        createdBy,
      })
      .returning();
    return row!.id;
  }

  const openSession = (orgId: string, serverId: string, userId: string, expiresAt: Date) =>
    repo.record({
      orgId,
      serverId,
      serverName: 'box-1',
      serverHost: 'example.com',
      userId,
      outcome: 'open',
      expiresAt,
    });

  const expiryOf = async (sessionId: string): Promise<Date> => {
    const [row] = await client.db
      .select({ expiresAt: serverShellSession.expiresAt })
      .from(serverShellSession)
      .where(eq(serverShellSession.id, sessionId));
    return row!.expiresAt;
  };

  beforeEach(async () => {
    await truncate(client.db, [serverShellSession, server, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    serverA = await makeServer(orgA, a.ownerId);
  });

  afterAll(async () => {
    await client.close?.();
  });

  it('extends a session belonging to the renewing org', async () => {
    const original = new Date(Date.now() + 60_000);
    const sessionId = await openSession(orgA, serverA, ownerA, original);
    const next = new Date(original.getTime() + 30 * 60_000);

    await expect(repo.extendExpiry({ sessionId, orgId: orgA, expiresAt: next })).resolves.toBe(
      true,
    );
    expect((await expiryOf(sessionId)).getTime()).toBe(next.getTime());
  });

  /** The boundary: another org's renewal must not move this row. */
  it('refuses to extend another org’s session, and leaves the expiry alone', async () => {
    const original = new Date(Date.now() + 60_000);
    const sessionId = await openSession(orgA, serverA, ownerA, original);

    await expect(
      repo.extendExpiry({
        sessionId,
        orgId: orgB,
        expiresAt: new Date(original.getTime() + 30 * 60_000),
      }),
    ).resolves.toBe(false);
    expect((await expiryOf(sessionId)).getTime()).toBe(original.getTime());
  });

  /** A finished session is history; its recorded window must not move. */
  it('refuses to extend a session that is already closed out', async () => {
    const original = new Date(Date.now() + 60_000);
    const sessionId = await openSession(orgA, serverA, ownerA, original);
    await repo.close({
      sessionId,
      outcome: 'closed',
      transcript: '',
      bytesIn: 0,
      bytesOut: 0,
    });

    await expect(
      repo.extendExpiry({
        sessionId,
        orgId: orgA,
        expiresAt: new Date(original.getTime() + 30 * 60_000),
      }),
    ).resolves.toBe(false);
    expect((await expiryOf(sessionId)).getTime()).toBe(original.getTime());
  });
});
