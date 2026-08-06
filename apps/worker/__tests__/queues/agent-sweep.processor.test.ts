import {
  createDatabaseClient,
  agent,
  apiKey,
  organization,
  organizationUser,
  project,
  task,
  taskComment,
  user,
  eq,
  type DatabaseClient,
} from '@pkg/database';
import { STALE_CLAIM_AFTER_MS } from '@pkg/contracts';
import { describeIntegration, truncate } from '@pkg/testing';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { Queue, Job } from 'bullmq';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { AgentSweepProcessor } from '@/queues/agent-sweep/agent-sweep.processor';

const SILENT = new Date(Date.now() - STALE_CLAIM_AFTER_MS - 60_000);
const ALIVE = new Date();

/**
 * The stale-claim release against a real database: only in_progress claims
 * with POSITIVE evidence of a dead agent are released; blocked, needs_review
 * and presence-less claims are never touched.
 */
describeIntegration('AgentSweepProcessor — stale-claim release', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const processor = new AgentSweepProcessor(
    client,
    { upsertJobScheduler: async () => undefined } as unknown as Queue,
    new FakeLogger().as<PinoLogger>(),
  );

  let orgId: string;
  let userId: string;
  let keyId: string;
  let projectId: string;

  const tables = [taskComment, task, agent, apiKey, project, organizationUser, organization, user];

  beforeEach(async () => {
    await truncate(client.db, tables);
    const [owner] = await client.db
      .insert(user)
      .values({ email: 'sweep@example.com', name: 'Sweep', passwordHash: 'x' })
      .returning();
    userId = owner!.id;
    const [org] = await client.db
      .insert(organization)
      .values({ name: 'sweep-org', ownerId: userId })
      .returning();
    orgId = org!.id;
    await client.db.insert(organizationUser).values({ orgId, userId, role: 'OWNER' });
    const [proj] = await client.db
      .insert(project)
      .values({ orgId, name: 'sweep-project', createdBy: userId })
      .returning();
    projectId = proj!.id;
    const [key] = await client.db
      .insert(apiKey)
      .values({
        name: 'runner',
        prefix: 'sk_test',
        hashedKey: `h-${Date.now()}`,
        scopes: ['tasks:agent'],
        userId,
        orgId,
      })
      .returning();
    keyId = key!.id;
  });

  afterAll(async () => {
    await truncate(client.db, tables);
    await client.close();
  });

  const makeTask = async (status: string) => {
    const [row] = await client.db
      .insert(task)
      .values({
        projectId,
        title: `t-${status}-${Math.random()}`,
        status,
        claimedBy: userId,
        claimedAt: new Date(),
        createdBy: userId,
      })
      .returning();
    return row!;
  };

  const makeAgent = async (lastSeenAt: Date | null) => {
    await client.db.insert(agent).values({
      orgId,
      name: 'runner',
      apiKeyId: keyId,
      kind: 'external',
      status: 'working',
      lastSeenAt,
    });
  };

  it('releases an in_progress claim whose agent went silent, with an audit comment', async () => {
    const claimed = await makeTask('in_progress');
    await makeAgent(SILENT);

    const result = await processor.process({} as Job);
    expect(result.released).toBe(1);

    const [after] = await client.db.select().from(task).where(eq(task.id, claimed.id));
    expect(after!.status).toBe('ready');
    expect(after!.claimedBy).toBeNull();
    expect(after!.claimedAt).toBeNull();

    const comments = await client.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, claimed.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('claim released');
    expect(comments[0]!.body).toContain('runner');
  });

  it('a live agent keeps its claim', async () => {
    const claimed = await makeTask('in_progress');
    await makeAgent(ALIVE);

    const result = await processor.process({} as Job);
    expect(result.released).toBe(0);
    const [after] = await client.db.select().from(task).where(eq(task.id, claimed.id));
    expect(after!.status).toBe('in_progress');
  });

  it('never touches blocked or needs_review, even with a silent agent', async () => {
    const blocked = await makeTask('blocked');
    const review = await makeTask('needs_review');
    await makeAgent(SILENT);

    const result = await processor.process({} as Job);
    expect(result.released).toBe(0);
    const [b] = await client.db.select().from(task).where(eq(task.id, blocked.id));
    const [r] = await client.db.select().from(task).where(eq(task.id, review.id));
    expect(b!.status).toBe('blocked');
    expect(r!.status).toBe('needs_review');
  });

  it('a claim with NO agent rows is left untouched — absence of evidence is not death', async () => {
    const claimed = await makeTask('in_progress');
    // no agent row at all

    const result = await processor.process({} as Job);
    expect(result.released).toBe(0);
    const [after] = await client.db.select().from(task).where(eq(task.id, claimed.id));
    expect(after!.status).toBe('in_progress');
  });

  it('is idempotent: a second run releases nothing more', async () => {
    await makeTask('in_progress');
    await makeAgent(SILENT);

    expect((await processor.process({} as Job)).released).toBe(1);
    expect((await processor.process({} as Job)).released).toBe(0);
  });
});
