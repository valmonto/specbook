import {
  createDatabaseClient,
  organization,
  server,
  user,
  eq,
  type DatabaseClient,
} from '@pkg/database';
import type { SecretsService, SshService } from '@pkg/server';
import { describeIntegration, truncate, FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { Queue, Job } from 'bullmq';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { ServerCheckProcessor } from '@/queues/server-check/server-check.processor.js';

/**
 * What the row says AFTER a failed check.
 *
 * `lastCheckError` exists to answer "why", and it used to be written from the
 * coarse `reason` — which had already become the status. A row labelled
 * Unreachable explained itself with the word "unreachable", so the only way to
 * tell a wrong SSH user from a closed port was the worker logs. These pin the
 * detail that sshd actually returned.
 */
describeIntegration('ServerCheckProcessor — the row says why it failed', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });

  const secrets = { open: () => 'PRIVATE-KEY' } as unknown as SecretsService;
  const queue = { upsertJobScheduler: async () => undefined } as unknown as Queue;

  const makeProcessor = (result: unknown) =>
    new ServerCheckProcessor(
      client,
      { testConnection: vi.fn().mockResolvedValue(result) } as unknown as SshService,
      secrets,
      queue,
      new FakeLogger().as<PinoLogger>(),
    );

  let serverId: string;

  beforeEach(async () => {
    await truncate(client.db, [server, organization, user]);
    const [owner] = await client.db
      .insert(user)
      .values({ email: 'check@example.com', name: 'Check', passwordHash: 'x' })
      .returning();
    const [org] = await client.db
      .insert(organization)
      .values({ name: 'check-org', ownerId: owner!.id })
      .returning();
    const [row] = await client.db
      .insert(server)
      .values({
        orgId: org!.id,
        name: 'box-1',
        host: 'box.example.com',
        roles: ['app'],
        publicKey: 'ssh-ed25519 AAAA',
        privateKeyEnc: 'sealed',
        createdBy: owner!.id,
      })
      .returning();
    serverId = row!.id;
  });

  /**
   * Leave the shared database as we found it. `server.createdBy` references
   * user with onDelete RESTRICT, so a server row left behind makes every later
   * suite's `truncate([..., user])` fail on a foreign key — a failure that
   * surfaces in someone else's tests with nothing pointing back here. Files
   * run serially (fileParallelism: false), so "later" is a real ordering.
   */
  afterAll(async () => {
    await truncate(client.db, [server, organization, user]);
  });

  const runCheck = async (result: unknown): Promise<string | null> => {
    await makeProcessor(result).process({ data: { serverId } } as Job);
    const [row] = await client.db.select().from(server).where(eq(server.id, serverId)).limit(1);
    return row!.lastCheckError;
  };

  it('stores what sshd said, not the bucket that became the status', async () => {
    const detail = 'All configured authentication methods failed';
    const stored = await runCheck({ ok: false, fingerprint: null, reason: 'unreachable', detail });

    expect(stored).toBe(detail);
    // The failure mode this guards: the reason restating the status.
    expect(stored).not.toBe('unreachable');
  });

  it.each([
    ['connect ECONNREFUSED 10.0.0.4:22', 'a closed port'],
    ['getaddrinfo ENOTFOUND box.example.com', 'a host that does not resolve'],
  ])('keeps %s, which is how you tell it from %s', async (detail) => {
    expect(await runCheck({ ok: false, fingerprint: null, reason: 'unreachable', detail })).toBe(
      detail,
    );
  });

  it('falls back to the reason when the driver reported no detail', async () => {
    expect(await runCheck({ ok: false, fingerprint: null, reason: 'unreachable' })).toBe(
      'unreachable',
    );
  });

  it('clears the explanation once the check passes', async () => {
    await runCheck({ ok: false, fingerprint: null, reason: 'unreachable', detail: 'refused' });
    expect(await runCheck({ ok: true, fingerprint: 'SHA256:abc' })).toBeNull();
  });
});
