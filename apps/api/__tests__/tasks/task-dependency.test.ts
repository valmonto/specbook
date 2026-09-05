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
 * The dependency add/remove path org-scoping, proven end to end against the
 * real repositories. Only the two repositories matter for this path, so the
 * other collaborators are stubs — the boundary is enforced by requireTask and
 * the org-scoped findById, not by convention. Two orgs prove tenancy; the
 * queue read proves the edge actually gates work.
 */
describeIntegration('TaskService — dependency edges, org-scoped', () => {
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

  async function makeTask(projectId: string, createdBy: string, title: string) {
    const [row] = await client.db
      .insert(task)
      .values({ projectId, title, status: 'ready', createdBy })
      .returning();
    return row!.id;
  }

  const as = (userId: string, orgId: string): ActiveUser =>
    ({ userId, orgId, orgRole: 'OWNER', systemRole: 'USER' }) as const;

  const availableTitles = async (orgId: string) => {
    const { data } = await repo.findForOrg(orgId, { skip: 0, limit: 20, available: true });
    return data.map((t) => t.title).sort();
  };

  beforeEach(async () => {
    await truncate(client.db, [taskDependency, task, project, organizationUser, organization, user]);
    const a = await makeOrg('dep-org-a');
    const b = await makeOrg('dep-org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    ownerB = b.ownerId;
    projA = await makeProject(orgA, ownerA, 'proj-a');
    projB = await makeProject(orgB, ownerB, 'proj-b');
  });

  afterAll(async () => {
    await truncate(client.db, [taskDependency, task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('adds a same-project edge and gates the dependent until its prerequisite is done', async () => {
    const a = await makeTask(projA, ownerA, 'A');
    const b = await makeTask(projA, ownerA, 'B');
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });
    expect(await availableTitles(orgA)).toEqual(['A']); // B gated
  });

  it('refuses a cross-org edge from either direction — the foreign task is a NotFound', async () => {
    const a = await makeTask(projA, ownerA, 'A'); // org A
    const foreign = await makeTask(projB, ownerB, 'foreign'); // org B

    // Org A's task cannot depend on org B's task (foreign prerequisite unseen).
    await expect(
      service.addDependency(as(ownerA, orgA), { id: a, dependsOnTaskId: foreign }),
    ).rejects.toThrow();

    // Org B cannot reach into org A's task as the dependent either.
    await expect(
      service.addDependency(as(ownerB, orgB), { id: a, dependsOnTaskId: foreign }),
    ).rejects.toThrow();

    // No edge was written by either attempt.
    const edges = await client.db.select().from(taskDependency);
    expect(edges).toHaveLength(0);
  });

  it('removes an edge it owns; a foreign org removes nothing', async () => {
    const a = await makeTask(projA, ownerA, 'A');
    const b = await makeTask(projA, ownerA, 'B');
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });

    // A foreign org cannot remove org A's edge (dependent task is a NotFound).
    await expect(
      service.removeDependency(as(ownerB, orgB), { id: b, dependsOnTaskId: a }),
    ).rejects.toThrow();

    // The owner removes it and B rejoins the queue.
    await service.removeDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });
    expect(await availableTitles(orgA)).toEqual(['A', 'B']);
  });

  it('create_task wires dependsOn through the guarded add path', async () => {
    const a = await makeTask(projA, ownerA, 'A');
    const created = await service.create(as(ownerA, orgA), {
      projectId: projA,
      title: 'B',
      dependsOn: [a],
    });
    const info = await repo.findDependencyInfo(created.id);
    expect(info.map((d) => d.id)).toEqual([a]);

    // The edge is live and gating: once the new task is dispatched (ready) it
    // still waits on A — it only enters the queue when A reaches done.
    await client.db.update(task).set({ status: 'ready' }).where(eq(task.id, created.id));
    expect(await availableTitles(orgA)).toEqual(['A']);
    await client.db.update(task).set({ status: 'done' }).where(eq(task.id, a));
    expect(await availableTitles(orgA)).toEqual(['B']);
  });

  it('create_task rejects a cross-org dependsOn id', async () => {
    const foreign = await makeTask(projB, ownerB, 'foreign');
    await expect(
      service.create(as(ownerA, orgA), { projectId: projA, title: 'B', dependsOn: [foreign] }),
    ).rejects.toThrow();
  });

  it('cancelling a prerequisite detaches its non-terminal dependents and comments on each', async () => {
    const a = await makeTask(projA, ownerA, 'A'); // prerequisite, ready
    const b = await makeTask(projA, ownerA, 'B'); // depends on A, ready (live)
    const c = await makeTask(projA, ownerA, 'C'); // depends on A, then made done
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });
    await service.addDependency(as(ownerA, orgA), { id: c, dependsOnTaskId: a });
    // C is a TERMINAL dependent — its edge must be left intact (settled history).
    await client.db.update(task).set({ status: 'done' }).where(eq(task.id, c));

    await service.transition(as(ownerA, orgA), 'user', { id: a, to: 'cancelled' });

    // The live dependent's edge is gone; the done dependent keeps its edge.
    const edges = await client.db.select().from(taskDependency);
    expect(edges.map((e) => e.taskId).sort()).toEqual([c]);

    // B carries a comment naming the cancelled dependency.
    const comments = await repo.findComments(b);
    expect(
      comments.some(
        (cm) => cm.body.includes('A') && cm.body.toLowerCase().includes('cancel'),
      ),
    ).toBe(true);

    // B no longer waits on anything, so it rejoins the queue (A/C are terminal).
    expect(await availableTitles(orgA)).toEqual(['B']);
  });

  it('a done prerequisite satisfies the queue; a lingering cancelled one never silently does', async () => {
    // done → satisfies: the dependent enters the queue.
    const a = await makeTask(projA, ownerA, 'A');
    const b = await makeTask(projA, ownerA, 'B');
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });
    await client.db.update(task).set({ status: 'done' }).where(eq(task.id, a));
    expect(await availableTitles(orgA)).toContain('B');

    // A lingering cancelled edge (e.g. surviving a done→changes_requested reopen)
    // must BLOCK, not silently satisfy — only `done` counts as satisfying.
    const c = await makeTask(projA, ownerA, 'C');
    const d = await makeTask(projA, ownerA, 'D'); // ready, depends on C
    await client.db.insert(taskDependency).values({ taskId: d, dependsOnTaskId: c });
    await client.db.update(task).set({ status: 'cancelled' }).where(eq(task.id, c));
    expect(await availableTitles(orgA)).not.toContain('D');
  });

  it('findEdgeSummaries returns both directions for the owner, and stays inside the org', async () => {
    const a = await makeTask(projA, ownerA, 'A'); // prerequisite
    const b = await makeTask(projA, ownerA, 'B'); // depends on A
    await service.addDependency(as(ownerA, orgA), { id: b, dependsOnTaskId: a });

    const { dependencies, dependents } = await repo.findEdgeSummaries(orgA, [a, b]);

    // B's dependency edge points at A; A's dependent edge points at B.
    expect(dependencies).toEqual([
      { ownerTaskId: b, id: a, title: 'A', status: 'ready' },
    ]);
    expect(dependents).toEqual([
      { ownerTaskId: a, id: b, title: 'B', status: 'ready' },
    ]);

    // A foreign org sees no edges for the same ids — the far task is joined to
    // its project on org_id, so org B resolves nothing.
    const foreign = await repo.findEdgeSummaries(orgB, [a, b]);
    expect(foreign.dependencies).toEqual([]);
    expect(foreign.dependents).toEqual([]);
  });
});
