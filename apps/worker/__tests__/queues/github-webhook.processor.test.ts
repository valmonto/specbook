import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  task,
  user,
  eq,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate, FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { GithubAppService, GithubWebhookJobPayload } from '@pkg/server';
import { vi } from 'vitest';
import { GithubWebhookProcessor } from '@/queues/github-webhook/github-webhook.processor';

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
  };
  const processor = new GithubWebhookProcessor(
    client,
    githubApp as unknown as GithubAppService,
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
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    taskA = await makeOrg('org-a', 777);
    taskB = await makeOrg('org-b', 888);
    githubApp.getPullRequest.mockReset().mockResolvedValue(null);
    githubApp.createPullRequest.mockReset().mockResolvedValue(12);
    githubApp.mergePullRequest.mockReset().mockResolvedValue(true);
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
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
});
