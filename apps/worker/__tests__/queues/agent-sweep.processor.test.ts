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
import type { GithubAppService, SecretsService, SshService } from '@pkg/server';
import { describeIntegration, truncate } from '@pkg/testing';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { Queue, Job } from 'bullmq';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { AgentSweepProcessor } from '@/queues/agent-sweep/agent-sweep.processor.js';

/** A GitHub App stub disabled by default — the stale-claim suite never opens PRs. */
const disabledGithubApp = { enabled: false } as unknown as GithubAppService;

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
    {} as SshService,
    {} as SecretsService,
    disabledGithubApp,
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

/**
 * Belt-and-suspenders recovery: the sweep opens a PR for any already-parked
 * needs_review task that has a branch but no PR, in an auto/auto_merge project.
 * The GitHub App is stubbed; the DB and the guards are real.
 */
describeIntegration('AgentSweepProcessor — parked review-PR recovery', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const githubApp = {
    enabled: true,
    getPullRequest: vi.fn().mockResolvedValue(null),
    createPullRequest: vi.fn().mockResolvedValue(101),
  };
  const processor = new AgentSweepProcessor(
    client,
    { upsertJobScheduler: async () => undefined } as unknown as Queue,
    {} as SshService,
    {} as SecretsService,
    githubApp as unknown as GithubAppService,
    new FakeLogger().as<PinoLogger>(),
  );

  const tables = [taskComment, task, agent, apiKey, project, organizationUser, organization, user];
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    await truncate(client.db, tables);
    githubApp.getPullRequest.mockReset().mockResolvedValue(null);
    githubApp.createPullRequest.mockReset().mockResolvedValue(101);
    const [owner] = await client.db
      .insert(user)
      .values({ email: 'recover@example.com', name: 'Recover', passwordHash: 'x' })
      .returning();
    userId = owner!.id;
    const [org] = await client.db
      .insert(organization)
      .values({ name: 'recover-org', ownerId: userId, githubInstallationId: 4242 })
      .returning();
    orgId = org!.id;
    await client.db.insert(organizationUser).values({ orgId, userId, role: 'OWNER' });
  });

  afterAll(async () => {
    await truncate(client.db, tables);
    await client.close();
  });

  const makeProject = async (over: Record<string, unknown> = {}) => {
    const [proj] = await client.db
      .insert(project)
      .values({
        orgId,
        name: 'recover-project',
        createdBy: userId,
        mode: 'auto',
        githubRepoFullName: 'valmonto/specbook',
        defaultBranch: 'main',
        ...over,
      })
      .returning();
    return proj!.id;
  };

  const makeParkedTask = async (projectId: string, over: Record<string, unknown> = {}) => {
    const [row] = await client.db
      .insert(task)
      .values({
        projectId,
        title: `parked-${Math.random()}`,
        status: 'needs_review',
        branch: 'feat/parked',
        createdBy: userId,
        ...over,
      })
      .returning();
    return row!.id;
  };

  it('opens a PR for a parked needs_review task (auto + branch + no PR)', async () => {
    const projectId = await makeProject();
    const taskId = await makeParkedTask(projectId);

    const { prsOpened } = await processor.process({} as Job);
    expect(prsOpened).toBe(1);
    expect(githubApp.createPullRequest).toHaveBeenCalledWith(4242, 'valmonto/specbook', {
      head: 'feat/parked',
      base: 'main',
      title: expect.any(String),
    });
    const [after] = await client.db.select().from(task).where(eq(task.id, taskId));
    expect(after!.prNumber).toBe(101);
    expect(after!.prUrl).toBe('https://github.com/valmonto/specbook/pull/101');
    expect(after!.prState).toBe('open');
    expect(after!.status).toBe('needs_review');
  });

  it('adopts an already-open PR for the branch instead of opening a duplicate', async () => {
    const projectId = await makeProject();
    const taskId = await makeParkedTask(projectId);
    githubApp.getPullRequest.mockResolvedValue({
      number: 55,
      url: 'https://github.com/valmonto/specbook/pull/55',
      state: 'open',
    });

    const { prsOpened } = await processor.process({} as Job);
    expect(prsOpened).toBe(1);
    expect(githubApp.createPullRequest).not.toHaveBeenCalled();
    const [after] = await client.db.select().from(task).where(eq(task.id, taskId));
    expect(after!.prNumber).toBe(55);
  });

  it('a branch already merged out-of-band finalizes the task to done', async () => {
    const projectId = await makeProject();
    const taskId = await makeParkedTask(projectId);
    githubApp.getPullRequest.mockResolvedValue({
      number: 9,
      url: 'https://github.com/valmonto/specbook/pull/9',
      state: 'merged',
    });

    await processor.process({} as Job);
    expect(githubApp.createPullRequest).not.toHaveBeenCalled();
    const [after] = await client.db.select().from(task).where(eq(task.id, taskId));
    expect(after!.status).toBe('done');
    expect(after!.prState).toBe('merged');
    expect(after!.prNumber).toBe(9);
  });

  it('leaves non-auto projects, human tasks, and already-PRd tasks untouched', async () => {
    const manual = await makeProject({ mode: 'manual', name: 'manual-p' });
    await makeParkedTask(manual);
    const auto = await makeProject({ name: 'auto-p' });
    await makeParkedTask(auto, { isHumanTask: true });
    await makeParkedTask(auto, { prNumber: 7 });

    const { prsOpened } = await processor.process({} as Job);
    expect(prsOpened).toBe(0);
    expect(githubApp.createPullRequest).not.toHaveBeenCalled();
  });

  it('a GitHub error on one task is logged and never stalls the sweep', async () => {
    const projectId = await makeProject();
    const failTask = await makeParkedTask(projectId, { branch: 'feat/boom' });
    const okTask = await makeParkedTask(projectId, { branch: 'feat/ok' });
    githubApp.createPullRequest.mockImplementation(async (_i, _r, opts: { head: string }) => {
      if (opts.head === 'feat/boom') throw new Error('no diff between base and head');
      return 202;
    });

    const { prsOpened } = await processor.process({} as Job);
    expect(prsOpened).toBe(1);
    const [failed] = await client.db.select().from(task).where(eq(task.id, failTask));
    expect(failed!.status).toBe('needs_review');
    expect(failed!.prNumber).toBeNull();
    const [ok] = await client.db.select().from(task).where(eq(task.id, okTask));
    expect(ok!.prNumber).toBe(202);
  });

  it('is idempotent: a second run opens nothing more', async () => {
    const projectId = await makeProject();
    await makeParkedTask(projectId);

    expect((await processor.process({} as Job)).prsOpened).toBe(1);
    // The task now has a prNumber, so the recovery query no longer selects it.
    githubApp.createPullRequest.mockClear();
    expect((await processor.process({} as Job)).prsOpened).toBe(0);
    expect(githubApp.createPullRequest).not.toHaveBeenCalled();
  });
});
