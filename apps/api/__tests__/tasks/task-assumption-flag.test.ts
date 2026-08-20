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
import { ProjectMemberRepository } from '@/tasks/project-member.repository';
import { TaskService } from '@/tasks/task.service';
import type { NotificationService } from '@/notifications/notification.service';
import type { OrgService } from '@/org/org.service';
import type { GithubAppService } from '@pkg/server';

/**
 * The assumption flag — an agent sets it, a human clears it — proven against
 * the real database, with two orgs so the org-scoped read is what keeps the
 * flag inside the tenant: neither setting nor reading nor clearing an assumption
 * can cross into another org's task (a foreign org is a NotFound, never a
 * cross-tenant write).
 */
describeIntegration('TaskService — assumption flag (agent sets, human clears)', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);
  const service = new TaskService(
    repo,
    new ProjectRepository(client),
    new ProjectMemberRepository(client),
    { create: async () => undefined } as unknown as NotificationService,
    {} as OrgService,
    { enabled: false } as unknown as GithubAppService,
    new FakeLogger().as<PinoLogger>(),
  );

  const flag = { what: 'used soft-delete', why: 'matches the module convention', howToVerify: 'check the repo query' };

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let ownerB: string;
  let claimantA: string;
  let projectA: string;

  const asUser = (userId: string, orgId: string): ActiveUser => ({
    userId,
    orgId,
    // All-access principal (owner): these suites predate per-project scoping
    // and exercise the agent court via the `actor` param, not the org role.
    orgRole: 'OWNER',
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

  async function makeTask(overrides: Record<string, unknown>) {
    const [row] = await client.db
      .insert(task)
      .values({
        projectId: projectA,
        title: 'a task',
        context: 'ctx',
        status: 'in_progress',
        claimedBy: claimantA,
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
    const [other] = await client.db
      .insert(user)
      .values({ email: 'claimant-a@example.com', name: 'claimant', passwordHash: 'x' })
      .returning();
    claimantA = other!.id;
    await client.db
      .insert(organizationUser)
      .values({ orgId: orgA, userId: claimantA, role: 'MEMBER' });
    const [proj] = await client.db
      .insert(project)
      .values({ orgId: orgA, name: 'alpha', createdBy: ownerA })
      .returning();
    projectA = proj!.id;
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('the claimant sets the flag; a fresh read returns it', async () => {
    const id = await makeTask({});

    const set = await service.setAssumption(asUser(claimantA, orgA), 'agent', { id, ...flag });
    expect(set.assumptionFlag).toEqual(flag);

    // Persisted, and visible on the org-scoped detail read.
    const detail = await service.getById(asUser(ownerA, orgA), id);
    expect(detail.assumptionFlag).toEqual(flag);
  });

  it('the human clears the flag', async () => {
    const id = await makeTask({ assumptionFlag: flag });

    const cleared = await service.clearAssumption(asUser(ownerA, orgA), id);
    expect(cleared.assumptionFlag).toBeNull();
    expect((await repo.findById(id, orgA))?.assumptionFlag).toBeNull();
  });

  it('cross-tenant: org B cannot SET the flag on org A’s task (NotFound, no write)', async () => {
    const id = await makeTask({});

    await expect(
      service.setAssumption(asUser(ownerB, orgB), 'agent', { id, ...flag }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The write never landed in org A.
    expect((await repo.findById(id, orgA))?.assumptionFlag).toBeNull();
  });

  it('cross-tenant: org B cannot CLEAR org A’s flag, nor read it (NotFound)', async () => {
    const id = await makeTask({ assumptionFlag: flag });

    await expect(
      service.clearAssumption(asUser(ownerB, orgB), id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getById(asUser(ownerB, orgB), id)).rejects.toBeInstanceOf(NotFoundException);

    // Org A's flag is untouched.
    expect((await repo.findById(id, orgA))?.assumptionFlag).toEqual(flag);
  });

  it('a non-claimant agent in the same org is refused (assumptionNotClaimant)', async () => {
    const id = await makeTask({ claimedBy: claimantA });

    await expect(
      service.setAssumption(asUser(ownerA, orgA), 'agent', { id, ...flag }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
