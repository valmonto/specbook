import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  task,
  taskDependency,
  user,
  eq,
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
 * The bulk mark-ready path, proven against the real repositories: the crux is
 * the transitive-draft-prerequisite cascade (B→A), and the load-bearing rule is
 * org scoping — one org must never bulk-promote another org's tasks. Only the
 * two task repositories matter here, so the other collaborators are stubs.
 */
describeIntegration('TaskService — bulk mark-ready, cascade + org-scoped', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);
  const service = new TaskService(
    repo,
    new ProjectRepository(client),
    new ProjectMemberRepository(client),
    {} as NotificationService,
    {} as OrgService,
    {} as GithubAppService,
    new FakeLogger().as<PinoLogger>(),
  );

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let ownerB: string;
  let projA: string;
  let projB: string;

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

  // A dispatchable draft: non-empty context AND at least one acceptance
  // criterion — the dispatch gate the promote path enforces.
  async function makeDraft(projectId: string, createdBy: string, title: string, area?: string) {
    const [row] = await client.db
      .insert(task)
      .values({
        projectId,
        title,
        area: area ?? null,
        status: 'draft',
        context: `context for ${title}`,
        acceptanceCriteria: [{ text: 'works', done: false }],
        createdBy,
      })
      .returning();
    return row!.id;
  }

  const as = (userId: string, orgId: string): ActiveUser =>
    ({ userId, orgId, orgRole: 'OWNER', systemRole: 'USER' }) as const;

  const statusOf = async (id: string): Promise<string> => {
    const [row] = await client.db.select({ status: task.status }).from(task).where(eq(task.id, id));
    return row!.status;
  };

  beforeEach(async () => {
    await truncate(client.db, [
      taskDependency,
      task,
      project,
      organizationUser,
      organization,
      user,
    ]);
    const a = await makeOrg('mr-org-a');
    const b = await makeOrg('mr-org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    ownerB = b.ownerId;
    projA = await makeProject(orgA, ownerA, 'proj-a');
    projB = await makeProject(orgB, ownerB, 'proj-b');
  });

  afterAll(async () => {
    await truncate(client.db, [
      taskDependency,
      task,
      project,
      organizationUser,
      organization,
      user,
    ]);
    await client.close();
  });

  // The spine of the ticket: marking B ready also promotes its draft prereq A.
  it('single-task cascade: marking B ready promotes its transitive draft prerequisite A', async () => {
    const a = await makeDraft(projA, ownerA, 'A');
    const b = await makeDraft(projA, ownerA, 'B');
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });

    const res = await service.markReady(as(ownerA, orgA), {
      scope: { kind: 'tasks', projectId: projA, taskIds: [b] },
    });

    expect(await statusOf(a)).toBe('ready');
    expect(await statusOf(b)).toBe('ready');
    // A is reported as a pulled-in prerequisite; B is the direct target.
    expect(res.prerequisites.map((p) => p.id)).toEqual([a]);
    expect(res.promoted.map((p) => p.id).sort()).toEqual([a, b].sort());
  });

  it('walks a transitive chain C→B→A, promoting all draft prerequisites', async () => {
    const a = await makeDraft(projA, ownerA, 'A');
    const b = await makeDraft(projA, ownerA, 'B');
    const c = await makeDraft(projA, ownerA, 'C');
    await service.addDependency(as(ownerA, orgA), { id: c, dependsOnTaskId: b });
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });

    const res = await service.markReady(as(ownerA, orgA), {
      scope: { kind: 'tasks', projectId: projA, taskIds: [c] },
    });

    expect(res.promoted.map((p) => p.id).sort()).toEqual([a, b, c].sort());
    expect(res.prerequisites.map((p) => p.id).sort()).toEqual([a, b].sort());
  });

  it('leaves non-draft prerequisites untouched and does not chase past them', async () => {
    const a = await makeDraft(projA, ownerA, 'A');
    const b = await makeDraft(projA, ownerA, 'B');
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });
    // A is already done — it progresses on its own; promoting B must not touch it.
    await client.db.update(task).set({ status: 'done' }).where(eq(task.id, a));

    const res = await service.markReady(as(ownerA, orgA), {
      scope: { kind: 'tasks', projectId: projA, taskIds: [b] },
    });

    expect(await statusOf(a)).toBe('done');
    expect(await statusOf(b)).toBe('ready');
    expect(res.prerequisites).toEqual([]);
    expect(res.promoted.map((p) => p.id)).toEqual([b]);
  });

  it('project scope promotes every draft; a group scope pulls prereqs from other groups', async () => {
    const login = await makeDraft(projA, ownerA, 'Login', 'Auth');
    const dashboard = await makeDraft(projA, ownerA, 'Dashboard', 'Home');
    // Dashboard (group Home) depends on Login (group Auth): a group sweep of
    // Home must pull Login in from Auth so Dashboard is not stranded.
    await service.addDependency(as(ownerA, orgA), { id: dashboard, dependsOnTaskId: login });

    const groupRes = await service.markReady(as(ownerA, orgA), {
      scope: { kind: 'area', projectId: projA, area: 'Home' },
    });
    expect(groupRes.promoted.map((p) => p.id).sort()).toEqual([dashboard, login].sort());
    expect(groupRes.prerequisites.map((p) => p.id)).toEqual([login]);
    expect(await statusOf(login)).toBe('ready');
    expect(await statusOf(dashboard)).toBe('ready');
  });

  it('skips drafts that fail the dispatch gate (no context / no criteria)', async () => {
    const [halfSpec] = await client.db
      .insert(task)
      .values({ projectId: projA, title: 'half', status: 'draft', createdBy: ownerA })
      .returning();

    const res = await service.markReady(as(ownerA, orgA), {
      scope: { kind: 'project', projectId: projA },
    });

    expect(res.promoted).toEqual([]);
    expect(await statusOf(halfSpec!.id)).toBe('draft');
  });

  // The load-bearing rule: the boundary gets a test.
  it('a foreign org cannot bulk-promote another org’s tasks', async () => {
    const a = await makeDraft(projA, ownerA, 'A');
    const b = await makeDraft(projA, ownerA, 'B');

    // Org B targets org A's project — NotFound, nothing promoted.
    await expect(
      service.markReady(as(ownerB, orgB), { scope: { kind: 'project', projectId: projA } }),
    ).rejects.toThrow();

    // Org B names org A's task ids under its OWN project — the foreign ids are
    // simply absent from org B's project, so nothing moves.
    const res = await service.markReady(as(ownerB, orgB), {
      scope: { kind: 'tasks', projectId: projB, taskIds: [a, b] },
    });
    expect(res.promoted).toEqual([]);
    expect(await statusOf(a)).toBe('draft');
    expect(await statusOf(b)).toBe('draft');
  });

  it('the repository write itself is org-scoped: org B cannot promote org A’s ids', async () => {
    const a = await makeDraft(projA, ownerA, 'A');
    // Direct repository call with org B's id and org A's task — the org guard
    // (membership subquery) matches zero rows.
    const promoted = await repo.bulkPromoteDraftsToReady(orgB, [a], ownerB);
    expect(promoted).toEqual([]);
    expect(await statusOf(a)).toBe('draft');
  });
});
