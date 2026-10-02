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
import { describeIntegration, FakeLogger, truncate } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { TaskRepository } from '@/tasks/task.repository.js';
import { ProjectRepository } from '@/tasks/project.repository.js';
import { ProjectMemberRepository } from '@/tasks/project-member.repository.js';
import { TaskService } from '@/tasks/task.service.js';
import type { NotificationService } from '@/notifications/notification.service.js';
import type { OrgService } from '@/org/org.service.js';
import type { GithubAppService } from '@pkg/server';

/**
 * `autonomous` is the last notch of the trust dial, and the only one that
 * changes the KIND of autonomy rather than the amount: under every other mode
 * a human decides what gets worked on, because draft → ready is human-only.
 *
 * So the tests that matter are the boundaries. That the gate is lifted for
 * autonomous projects, that it is NOT lifted for anything else, that lifting
 * it does not also lift the QUALITY gates (a draft still needs a spec), and
 * that one org's mode can never widen an agent's moves on another's task.
 */
describeIntegration('TaskService — autonomous mode lifts the dispatch gate', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const service = new TaskService(
    new TaskRepository(client),
    new ProjectRepository(client),
    new ProjectMemberRepository(client),
    {} as NotificationService,
    {} as OrgService,
    {} as GithubAppService,
    new FakeLogger().as<PinoLogger>(),
  );

  let orgA: string;
  let ownerA: string;
  let autoProject: string;
  let autonomousProject: string;

  const agent = (orgId: string, userId: string): ActiveUser =>
    ({ userId, orgId, orgRole: 'ADMIN', systemRole: 'USER' }) as ActiveUser;

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

  async function makeProject(orgId: string, ownerId: string, name: string, mode: string) {
    const [row] = await client.db
      .insert(project)
      .values({ orgId, name, mode, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  /** A dispatchable draft: the quality gate wants context AND criteria. */
  async function makeDraft(projectId: string, createdBy: string, spec = true) {
    const [row] = await client.db
      .insert(task)
      .values({
        projectId,
        title: 'a task',
        status: 'draft',
        context: spec ? 'why this exists' : null,
        acceptanceCriteria: spec ? [{ text: 'works', done: false }] : [],
        createdBy,
      })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    orgA = a.orgId;
    ownerA = a.ownerId;
    autoProject = await makeProject(orgA, ownerA, 'on-auto', 'auto');
    autonomousProject = await makeProject(orgA, ownerA, 'on-autonomous', 'autonomous');
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close?.();
  });

  it('lets an agent dispatch its own work on an autonomous project', async () => {
    const id = await makeDraft(autonomousProject, ownerA);

    const result = await service.transition(agent(orgA, ownerA), 'agent', {
      id,
      to: 'ready',
    } as never);

    expect(result.status).toBe('ready');
  });

  /** The boundary: every other mode keeps this edge human-only. */
  it('refuses the same move on a project that is merely full-auto', async () => {
    const id = await makeDraft(autoProject, ownerA);

    await expect(
      service.transition(agent(orgA, ownerA), 'agent', { id, to: 'ready' } as never),
    ).rejects.toThrow();
  });

  /**
   * Lifting WHO may dispatch must not lift WHAT a dispatched task needs. A
   * draft with no context and no criteria is still not dispatchable — that
   * gate is about leaving an auditable spec, not about permission.
   */
  it('still enforces the dispatch quality gate on an autonomous project', async () => {
    const id = await makeDraft(autonomousProject, ownerA, false);

    await expect(
      service.transition(agent(orgA, ownerA), 'agent', { id, to: 'ready' } as never),
    ).rejects.toThrow();
  });

  /** A human's moves are unchanged by the dial. */
  it('leaves the human path working on a full-auto project', async () => {
    const id = await makeDraft(autoProject, ownerA);

    const result = await service.transition(agent(orgA, ownerA), 'user', {
      id,
      to: 'ready',
    } as never);

    expect(result.status).toBe('ready');
  });

  /**
   * The regression that only showed up in real use: the first cut REPLACED the
   * agent's map with the owner's, which silently removed `ready → in_progress`
   * — an executor edge the owner's map has no reason to carry. The agent could
   * queue its own work and then not start it.
   */
  it('still lets an agent claim a ready task — the executor moves survive', async () => {
    const id = await makeDraft(autonomousProject, ownerA);
    await service.transition(agent(orgA, ownerA), 'agent', { id, to: 'ready' } as never);

    const result = await service.transition(agent(orgA, ownerA), 'agent', {
      id,
      to: 'in_progress',
    } as never);

    expect(result.status).toBe('in_progress');
  });

  /** The whole point of the union: owner moves AND executor moves, together. */
  it('gives an autonomous agent both courts in one run', async () => {
    const id = await makeDraft(autonomousProject, ownerA);

    await service.transition(agent(orgA, ownerA), 'agent', { id, to: 'ready' } as never);
    await service.transition(agent(orgA, ownerA), 'agent', { id, to: 'in_progress' } as never);
    const blocked = await service.transition(agent(orgA, ownerA), 'agent', {
      id,
      to: 'blocked',
      comment: 'a question',
    } as never);

    expect(blocked.status).toBe('blocked');
  });

  /**
   * The tenancy boundary: the mode consulted must be the mode of the task's
   * OWN project, read inside the acting org. A foreign org's autonomous
   * project must never widen an agent's moves here.
   */
  it('does not let another org’s task be dispatched by an agent', async () => {
    const b = await makeOrg('org-b');
    const foreign = await makeProject(b.orgId, b.ownerId, 'theirs', 'autonomous');
    const id = await makeDraft(foreign, b.ownerId);

    await expect(
      service.transition(agent(orgA, ownerA), 'agent', { id, to: 'ready' } as never),
    ).rejects.toThrow();
  });
});
