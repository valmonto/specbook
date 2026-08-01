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
import type { GithubWebhookJobPayload } from '@pkg/server';
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
  const processor = new GithubWebhookProcessor(client, new FakeLogger().as<PinoLogger>());

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
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  const prEvent = (installationId: number): GithubWebhookJobPayload => ({
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
