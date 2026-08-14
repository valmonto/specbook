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
import { TaskRepository } from '@/tasks/task.repository';
import { ProjectRepository } from '@/tasks/project.repository';
import { TaskService } from '@/tasks/task.service';
import type { NotificationService } from '@/notifications/notification.service';
import type { OrgService } from '@/org/org.service';
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
});
