import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  task,
  user,
  type DatabaseClient,
} from '@pkg/database';
import type { ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { TaskRepository } from '@/tasks/task.repository';
import { ProjectRepository } from '@/tasks/project.repository';
import { TaskService } from '@/tasks/task.service';
import type { NotificationService } from '@/notifications/notification.service';
import type { OrgService } from '@/org/org.service';
import type { GithubAppService } from '@pkg/server';

/**
 * agentUpdateSpec — the agent's spec-repair door — proven against the real
 * database. It edits ONLY the captured spec fields, and only while the spec
 * is the agent's to shape: a draft, or an in_progress task the SAME agent has
 * claimed. Two orgs prove the org-scoped read keeps the edit inside the
 * tenant (a foreign org is a NotFound, never a cross-tenant write).
 */
describeIntegration('TaskService.agentUpdateSpec — the agent spec-repair door', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);
  const service = new TaskService(
    repo,
    new ProjectRepository(client),
    { create: async () => undefined } as unknown as NotificationService,
    {} as OrgService,
    { enabled: false } as unknown as GithubAppService,
    new FakeLogger().as<PinoLogger>(),
  );

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let ownerB: string;
  let claimantA: string;
  let projectA: string;

  const asUser = (userId: string, orgId: string): ActiveUser => ({
    userId,
    orgId,
    orgRole: 'MEMBER',
    systemRole: 'USER',
  });

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

  async function makeProject(orgId: string, ownerId: string, name: string) {
    const [row] = await client.db
      .insert(project)
      .values({ orgId, name, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  async function makeTask(overrides: Record<string, unknown>) {
    const [row] = await client.db
      .insert(task)
      .values({
        projectId: projectA,
        title: 'original title',
        context: 'original context',
        status: 'draft',
        createdBy: ownerA,
        ...overrides,
      })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    ownerB = b.ownerId;
    // A second member of org A stands in for a different agent identity.
    const [other] = await client.db
      .insert(user)
      .values({ email: 'claimant-a@example.com', name: 'claimant', passwordHash: 'x' })
      .returning();
    claimantA = other!.id;
    await client.db
      .insert(organizationUser)
      .values({ orgId: orgA, userId: claimantA, role: 'MEMBER' });
    projectA = await makeProject(orgA, ownerA, 'alpha');
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('edits a draft: title, context, area and acceptance criteria are patched', async () => {
    const id = await makeTask({ status: 'draft' });

    const updated = await service.agentUpdateSpec(asUser(ownerA, orgA), {
      id,
      title: 'repaired title',
      context: 'repaired context',
      area: 'Billing',
      acceptanceCriteria: ['does the thing', 'and the other thing'],
    });

    expect(updated.title).toBe('repaired title');
    expect(updated.context).toBe('repaired context');
    expect(updated.area).toBe('Billing');
    // Full replacement, all unticked — mirrors create().
    expect(updated.acceptanceCriteria).toEqual([
      { text: 'does the thing', done: false },
      { text: 'and the other thing', done: false },
    ]);
    // Untouched fields survive.
    expect(updated.status).toBe('draft');
  });

  it('a partial edit leaves omitted fields untouched', async () => {
    const id = await makeTask({ status: 'draft', area: 'Onboarding' });

    const updated = await service.agentUpdateSpec(asUser(ownerA, orgA), { id, title: 'new title' });

    expect(updated.title).toBe('new title');
    expect(updated.context).toBe('original context');
    expect(updated.area).toBe('Onboarding');
  });

  it('an in_progress task is editable by its claimant', async () => {
    const id = await makeTask({ status: 'in_progress', claimedBy: claimantA });

    const updated = await service.agentUpdateSpec(asUser(claimantA, orgA), {
      id,
      context: 'refined mid-flight',
    });

    expect(updated.context).toBe('refined mid-flight');
    expect(updated.status).toBe('in_progress');
  });

  it('an in_progress task is NOT editable by a different user (notEditable)', async () => {
    const id = await makeTask({ status: 'in_progress', claimedBy: claimantA });

    await expect(
      service.agentUpdateSpec(asUser(ownerA, orgA), { id, title: 'not yours' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // The write never landed.
    expect((await repo.findById(id, orgA))?.title).toBe('original title');
  });

  it.each(['ready', 'needs_review', 'done'])(
    'a %s task is rejected (notEditable)',
    async (status) => {
      const id = await makeTask({ status, claimedBy: ownerA });

      await expect(
        service.agentUpdateSpec(asUser(ownerA, orgA), { id, title: 'too late' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    },
  );

  it('cross-tenant: org B editing org A’s task is a NotFound, no write', async () => {
    const id = await makeTask({ status: 'draft' });

    await expect(
      service.agentUpdateSpec(asUser(ownerB, orgB), { id, title: 'stolen edit' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect((await repo.findById(id, orgA))?.title).toBe('original title');
  });
});
