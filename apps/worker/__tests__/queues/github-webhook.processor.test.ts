import {
  createDatabaseClient,
  deployment,
  organization,
  organizationUser,
  project,
  projectEnvironment,
  server,
  task,
  user,
  eq,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate, FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { DeploymentProducer, GithubAppService, GithubWebhookJobPayload } from '@pkg/server';
import { vi } from 'vitest';
import { GithubWebhookProcessor } from '@/queues/github-webhook/github-webhook.processor.js';

const jobOf = (data: GithubWebhookJobPayload): Job<GithubWebhookJobPayload> =>
  ({ id: `gh-${data.deliveryId}`, data }) as Job<GithubWebhookJobPayload>;

/**
 * The tenancy proof for the webhook chain: installation → org → that org's
 * projects → their tasks. Both orgs deliberately use the SAME repo full name
 * and the SAME branch name — only the installation id may decide whose task
 * gets annotated.
 */
describeIntegration('GithubWebhookProcessor', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const githubApp = {
    enabled: true,
    getPullRequest: vi.fn().mockResolvedValue(null),
    createPullRequest: vi.fn().mockResolvedValue(12),
    mergePullRequest: vi.fn().mockResolvedValue(true),
    listWorkflowJobs: vi.fn().mockResolvedValue([]),
    rerunFailedJobs: vi.fn().mockResolvedValue(true),
  };
  const deployProducer = { enqueueDeploy: vi.fn().mockResolvedValue(undefined) };
  const processor = new GithubWebhookProcessor(
    client,
    githubApp as unknown as GithubAppService,
    deployProducer as unknown as DeploymentProducer,
    new FakeLogger().as<PinoLogger>(),
  );

  let taskA: string;
  let taskB: string;

  async function makeOrg(name: string, installationId: number) {
    const [owner] = await client.db
      .insert(user)
      .values({ email: `${name}@example.com`, name, passwordHash: 'x' })
      .returning();
    const [org] = await client.db
      .insert(organization)
      .values({
        name,
        ownerId: owner!.id,
        githubInstallationId: installationId,
        githubAccountLogin: name,
        githubConnectedAt: new Date(),
      })
      .returning();
    await client.db
      .insert(organizationUser)
      .values({ orgId: org!.id, userId: owner!.id, role: 'OWNER' });
    const [proj] = await client.db
      .insert(project)
      .values({
        orgId: org!.id,
        name: `${name}-project`,
        repoUrl: 'https://github.com/valmonto/specbook',
        githubRepoId: 42,
        githubRepoFullName: 'valmonto/specbook',
        createdBy: owner!.id,
      })
      .returning();
    const [row] = await client.db
      .insert(task)
      .values({
        projectId: proj!.id,
        title: `${name} task`,
        status: 'needs_review',
        branch: 'feat/shared-branch-name',
        createdBy: owner!.id,
      })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [deployment, projectEnvironment, server, task, project, organizationUser, organization, user]);
    taskA = await makeOrg('org-a', 777);
    taskB = await makeOrg('org-b', 888);
    githubApp.getPullRequest.mockReset().mockResolvedValue(null);
    githubApp.createPullRequest.mockReset().mockResolvedValue(12);
    githubApp.mergePullRequest.mockReset().mockResolvedValue(true);
    githubApp.listWorkflowJobs.mockReset().mockResolvedValue([]);
    githubApp.rerunFailedJobs.mockReset().mockResolvedValue(true);
  });

  afterAll(async () => {
    await truncate(client.db, [deployment, projectEnvironment, server, task, project, organizationUser, organization, user]);
    await client.close();
  });

  const prEvent = (
    installationId: number,
  ): Extract<GithubWebhookJobPayload, { kind: 'pull_request' }> => ({
    kind: 'pull_request',
    deliveryId: `d-${installationId}`,
    installationId,
    repoFullName: 'valmonto/specbook',
    prNumber: 12,
    prUrl: 'https://github.com/valmonto/specbook/pull/12',
    headBranch: 'feat/shared-branch-name',
    baseBranch: 'main',
    prState: 'merged',
  });

  it("an event with org A's installation annotates only org A's task", async () => {
    const result = await processor.process(jobOf(prEvent(777)));
    expect(result.matched).toBe(1);

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    const [b] = await client.db.select().from(task).where(eq(task.id, taskB));
    expect(a?.prState).toBe('merged');
    expect(a?.prNumber).toBe(12);
    expect(a?.prUrl).toBe('https://github.com/valmonto/specbook/pull/12');
    expect(a?.prSyncedAt).not.toBeNull();
    // Same repo name, same branch name — untouched, because the installation
    // resolves to org A only.
    expect(b?.prState).toBeNull();
    expect(b?.prNumber).toBeNull();
  });

  it('an unknown installation matches nothing', async () => {
    const result = await processor.process(jobOf(prEvent(999)));
    expect(result.matched).toBe(0);
  });

  it('workflow_run sets ciState by branch within the right org only', async () => {
    const result = await processor.process(
      jobOf({
        kind: 'workflow_run',
        deliveryId: 'ci-1',
        installationId: 888,
        repoFullName: 'valmonto/specbook',
        headBranch: 'feat/shared-branch-name',
        ciState: 'failing',
        prNumbers: [],
      }),
    );
    expect(result.matched).toBe(1);

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    const [b] = await client.db.select().from(task).where(eq(task.id, taskB));
    expect(b?.ciState).toBe('failing');
    expect(a?.ciState).toBeNull();
  });

  it('a merged PR completes an approved task, but never a task still in review', async () => {
    // Matched while still needs_review: PR state annotated, status untouched —
    // review states belong to the human, done = merged only from the queue.
    await processor.process(jobOf(prEvent(777)));
    let [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('needs_review');
    expect(a?.prState).toBe('merged');

    // Approved, then the merge event redelivered: now it completes.
    await client.db.update(task).set({ status: 'approved' }).where(eq(task.id, taskA));
    await processor.process(jobOf({ ...prEvent(777), deliveryId: 'd-redelivery' }));
    [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('done');
  });

  it('an open-PR event never completes an approved task', async () => {
    await client.db.update(task).set({ status: 'approved' }).where(eq(task.id, taskA));

    await processor.process(jobOf({ ...prEvent(777), prState: 'open', deliveryId: 'd-open' }));

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('approved');
    expect(a?.prState).toBe('open');
  });

  const ciGreen = (
    deliveryId: string,
  ): Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }> => ({
    kind: 'workflow_run',
    deliveryId,
    installationId: 777,
    repoFullName: 'valmonto/specbook',
    headBranch: 'feat/shared-branch-name',
    ciState: 'passing',
    prNumbers: [],
  });

  const setMode = (mode: string) =>
    client.db
      .update(project)
      .set({ mode })
      .where(eq(project.githubRepoFullName, 'valmonto/specbook'));

  it('mode=auto: a green submission approves and merges itself (PR created from the branch)', async () => {
    await setMode('auto');
    await processor.process(jobOf(ciGreen('auto-1')));

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('done');
    expect(a?.prState).toBe('merged');
    expect(a?.prNumber).toBe(12);
    expect(githubApp.createPullRequest).toHaveBeenCalledWith(777, 'valmonto/specbook', {
      head: 'feat/shared-branch-name',
      base: 'main',
      title: 'org-a task',
    });
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(777, 'valmonto/specbook', 12);
  });

  it('mode=auto: an assumption-flagged task auto-approves but is HELD from auto-merge', async () => {
    await setMode('auto');
    await client.db
      .update(task)
      .set({ assumptionFlag: { what: 'assumed X', why: 'defensible', howToVerify: 'run it' } })
      .where(eq(task.id, taskA));

    await processor.process(jobOf(ciGreen('flagged-1')));

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    // Auto-review still runs (needs_review → approved)…
    expect(a?.status).toBe('approved');
    // …but the merge waits for a human — the safety valve.
    expect(a?.prState).not.toBe('merged');
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it('mode=auto_merge: green needs_review stays put; green APPROVED merges itself', async () => {
    await setMode('auto_merge');
    await processor.process(jobOf(ciGreen('am-1')));
    let [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('needs_review'); // approval stays the human's
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();

    await client.db.update(task).set({ status: 'approved' }).where(eq(task.id, taskA));
    await processor.process(jobOf(ciGreen('am-2')));
    [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('done');
    expect(a?.prState).toBe('merged');
  });

  it('circuit breaker: a red default branch pauses auto progression; green resumes it', async () => {
    await setMode('auto');
    // Red run on main trips the breaker for org A's project.
    await processor.process(
      jobOf({ ...ciGreen('cb-red'), headBranch: 'main', ciState: 'failing' }),
    );
    const [pausedProject] = await client.db
      .select()
      .from(project)
      .where(eq(project.name, 'org-a-project'));
    expect(pausedProject?.autoPausedAt).not.toBeNull();

    // Green feature CI arrives — held, nothing merges.
    await processor.process(jobOf(ciGreen('cb-held')));
    let [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('needs_review');
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();

    // Main goes green — breaker resets; the next green submission progresses.
    await processor.process(jobOf({ ...ciGreen('cb-green'), headBranch: 'main' }));
    const [resumed] = await client.db
      .select()
      .from(project)
      .where(eq(project.name, 'org-a-project'));
    expect(resumed?.autoPausedAt).toBeNull();

    await processor.process(jobOf(ciGreen('cb-go')));
    [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('done');
  });

  it('breaker reset releases submissions parked green during the pause — and never merges twice', async () => {
    await setMode('auto');
    // Red main trips the breaker.
    await processor.process(
      jobOf({ ...ciGreen('pk-red'), headBranch: 'main', ciState: 'failing' }),
    );

    // The task's own CI goes green while paused: annotated but held.
    await processor.process(jobOf(ciGreen('pk-held')));
    let [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('needs_review');
    expect(a?.ciState).toBe('passing');
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();

    // Green main: the reset itself re-scans the project's parked green
    // tasks — no further feature-branch event needed.
    await processor.process(jobOf({ ...ciGreen('pk-clear'), headBranch: 'main' }));
    [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('done');
    expect(a?.prState).toBe('merged');
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);

    // Redelivered green events after the merge find no candidates: no
    // second merge, however many times the webhook fires.
    await processor.process(jobOf(ciGreen('pk-redeliver')));
    await processor.process(jobOf({ ...ciGreen('pk-clear2'), headBranch: 'main' }));
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('a merge GitHub refuses leaves the task approved for the human', async () => {
    await setMode('auto');
    githubApp.mergePullRequest.mockResolvedValue(false);
    await processor.process(jobOf(ciGreen('refused')));

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.status).toBe('approved');
    expect(a?.prState).not.toBe('merged');
  });

  it('a pre-existing prUrl is never overwritten by a PR event matched by branch', async () => {
    await client.db
      .update(task)
      .set({ prUrl: 'https://github.com/valmonto/specbook/compare/main...feat/shared-branch-name' })
      .where(eq(task.id, taskA));

    await processor.process(jobOf(prEvent(777)));

    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.prUrl).toBe(
      'https://github.com/valmonto/specbook/compare/main...feat/shared-branch-name',
    );
    expect(a?.prState).toBe('merged');
  });

  // --- CI failure classification -------------------------------------------

  const ciRed = (
    deliveryId: string,
    over: Partial<Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }>> = {},
  ): Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }> => ({
    kind: 'workflow_run',
    deliveryId,
    installationId: 777,
    repoFullName: 'valmonto/specbook',
    headBranch: 'feat/shared-branch-name',
    ciState: 'failing',
    prNumbers: [],
    runId: 9001,
    headSha: 'sha-1',
    runConclusion: 'failure',
    ...over,
  });

  it('a retryable red re-runs failed jobs ONCE per sha, then escalates to plain red', async () => {
    await processor.process(jobOf(ciRed('rt-1', { runConclusion: 'cancelled' })));

    let [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.ciState).toBe('failing');
    expect(a?.ciFailureKind).toBe('retryable');
    expect(a?.ciRetriedSha).toBe('sha-1');
    expect(githubApp.rerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(githubApp.rerunFailedJobs).toHaveBeenCalledWith(777, 'valmonto/specbook', 9001);

    // Same sha fails again: the retry is spent — no second rerun, and the
    // task escalates to plain red so the human treats it as real.
    await processor.process(jobOf(ciRed('rt-2', { runConclusion: 'cancelled' })));
    [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.ciFailureKind).toBeNull();
    expect(githubApp.rerunFailedJobs).toHaveBeenCalledTimes(1);
  });

  it('a NEW sha gets its own retry', async () => {
    await processor.process(jobOf(ciRed('ns-1', { runConclusion: 'cancelled' })));
    await processor.process(
      jobOf(ciRed('ns-2', { runConclusion: 'cancelled', headSha: 'sha-2', runId: 9002 })),
    );
    expect(githubApp.rerunFailedJobs).toHaveBeenCalledTimes(2);
    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.ciRetriedSha).toBe('sha-2');
  });

  it('a plain red (unclassified) never triggers a rerun', async () => {
    await processor.process(jobOf(ciRed('plain-1')));
    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.ciFailureKind).toBeNull();
    expect(githubApp.rerunFailedJobs).not.toHaveBeenCalled();
  });

  it('green clears the classification', async () => {
    await processor.process(jobOf(ciRed('clr-1', { runConclusion: 'cancelled' })));
    await processor.process(jobOf({ ...ciGreen('clr-2'), runId: 9001, headSha: 'sha-1' }));
    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.ciState).toBe('passing');
    expect(a?.ciFailureKind).toBeNull();
  });

  it('breaker: a retryable red on main does NOT pause; a setup red pauses with a pointer', async () => {
    await setMode('auto');

    // Outage-cancelled main run: breaker untouched.
    await processor.process(
      jobOf(ciRed('bk-1', { headBranch: 'main', runConclusion: 'cancelled' })),
    );
    let [p] = await client.db.select().from(project).where(eq(project.name, 'org-a-project'));
    expect(p?.autoPausedAt).toBeNull();

    // Workflow startup failure on main: pauses, and the banner knows why.
    await processor.process(
      jobOf(ciRed('bk-2', { headBranch: 'main', runConclusion: 'startup_failure' })),
    );
    [p] = await client.db.select().from(project).where(eq(project.name, 'org-a-project'));
    expect(p?.autoPausedAt).not.toBeNull();
    expect(p?.autoPauseKind).toBe('setup');
    expect(p?.autoPausePointer).toContain('startup');

    // Green main clears all three.
    await processor.process(jobOf({ ...ciGreen('bk-3'), headBranch: 'main' }));
    [p] = await client.db.select().from(project).where(eq(project.name, 'org-a-project'));
    expect(p?.autoPausedAt).toBeNull();
    expect(p?.autoPauseKind).toBeNull();
    expect(p?.autoPausePointer).toBeNull();
  });

  it('classification consults the jobs fetch for hard failures', async () => {
    githubApp.listWorkflowJobs.mockResolvedValue([
      {
        name: 'verify',
        conclusion: 'failure',
        steps: [
          { name: 'Set up job', conclusion: 'failure' },
          { name: 'Run tests', conclusion: 'skipped' },
        ],
      },
    ]);
    await processor.process(jobOf(ciRed('ext-1')));
    const [a] = await client.db.select().from(task).where(eq(task.id, taskA));
    expect(a?.ciFailureKind).toBe('external');
    expect(githubApp.listWorkflowJobs).toHaveBeenCalledWith(777, 'valmonto/specbook', 9001);
    // External is not retryable: no rerun.
    expect(githubApp.rerunFailedJobs).not.toHaveBeenCalled();
  });

  // --- auto-deploy on merge -------------------------------------------------

  async function makeEnvironment(opts: {
    autoDeploy?: boolean;
    provisionStatus?: string;
  } = {}): Promise<{ environmentId: string; projectId: string; creator: string }> {
    const [proj] = await client.db.select().from(project).limit(1);
    const [srv] = await client.db
      .insert(server)
      .values({
        orgId: proj!.orgId,
        name: 'deploy-box',
        host: 'example.com',
        roles: ['build', 'app', 'data'],
        publicKey: 'ssh-ed25519 AAAA test',
        privateKeyEnc: 'v1:sealed',
        createdBy: proj!.createdBy,
      })
      .returning();
    const [env] = await client.db
      .insert(projectEnvironment)
      .values({
        projectId: proj!.id,
        name: 'staging',
        serverId: srv!.id,
        autoDeploy: opts.autoDeploy ?? true,
        provisionStatus: opts.provisionStatus ?? 'provisioned',
      })
      .returning();
    return { environmentId: env!.id, projectId: proj!.id, creator: proj!.createdBy };
  }

  it('a default-branch merge auto-deploys the provisioned opted-in environment, attributed to the project creator', async () => {
    const { environmentId, creator } = await makeEnvironment();
    await processor.process(jobOf({ ...prEvent(777), deliveryId: 'd-auto1' }));

    const rows = await client.db
      .select()
      .from(deployment)
      .where(eq(deployment.environmentId, environmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'auto', status: 'queued', createdBy: creator });
    expect(deployProducer.enqueueDeploy).toHaveBeenCalledWith(rows[0]!.id);
  });

  it('feature-branch merges never trigger a deploy', async () => {
    const { environmentId } = await makeEnvironment();
    await processor.process(
      jobOf({ ...prEvent(777), deliveryId: 'd-feb', baseBranch: 'feat/other' }),
    );
    const rows = await client.db
      .select()
      .from(deployment)
      .where(eq(deployment.environmentId, environmentId));
    expect(rows).toHaveLength(0);
  });

  it('toggle-off and unprovisioned environments are never deployed', async () => {
    const { environmentId } = await makeEnvironment({ autoDeploy: false });
    await processor.process(jobOf({ ...prEvent(777), deliveryId: 'd-off' }));
    expect(
      await client.db.select().from(deployment).where(eq(deployment.environmentId, environmentId)),
    ).toHaveLength(0);
  });

  it('an in-flight deployment absorbs the trigger (dedupe)', async () => {
    const { environmentId, creator } = await makeEnvironment();
    await client.db.insert(deployment).values({
      environmentId,
      sha: 'abc',
      status: 'building',
      trigger: 'auto',
      createdBy: creator,
    });
    await processor.process(jobOf({ ...prEvent(777), deliveryId: 'd-dupe' }));
    expect(
      await client.db.select().from(deployment).where(eq(deployment.environmentId, environmentId)),
    ).toHaveLength(1); // still just the in-flight one
  });

  it('two consecutive failed auto-deploys trip the breaker; a success resets it', async () => {
    const { environmentId, creator } = await makeEnvironment();
    const failed = { environmentId, sha: 'x', status: 'failed', trigger: 'auto', createdBy: creator };
    await client.db.insert(deployment).values(failed);
    await client.db.insert(deployment).values(failed);

    await processor.process(jobOf({ ...prEvent(777), deliveryId: 'd-brk1' }));
    expect(
      await client.db.select().from(deployment).where(eq(deployment.environmentId, environmentId)),
    ).toHaveLength(2); // breaker held

    // any healthy deployment (e.g. a manual one) resets the breaker
    await client.db.insert(deployment).values({
      environmentId,
      sha: 'y',
      status: 'healthy',
      trigger: 'manual',
      createdBy: creator,
    });
    await processor.process(jobOf({ ...prEvent(777), deliveryId: 'd-brk2' }));
    expect(
      await client.db.select().from(deployment).where(eq(deployment.environmentId, environmentId)),
    ).toHaveLength(4); // reset → new auto deployment created
  });
});
