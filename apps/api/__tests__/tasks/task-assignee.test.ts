import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  task,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { TaskRepository } from '@/tasks/task.repository.js';

/**
 * The human worker lane assignee on the read/write path: a task can be assigned
 * to a member, the "My tasks" read (findForOrg assigneeId) returns it, and both
 * the assignee filter and the assignment write stay inside the tenant. Two orgs
 * prove the boundary — the exact shape two real cross-tenant bugs were found in.
 */
describeIntegration('TaskRepository — assignee (human worker lane)', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let memberA: string;
  let ownerB: string;
  let projectA: string;
  let projectB: string;

  async function makeUser(name: string) {
    const [u] = await client.db
      .insert(user)
      .values({ email: `${name}@example.com`, name, passwordHash: 'x' })
      .returning();
    return u!.id;
  }

  async function makeOrg(name: string, ownerId: string) {
    const [org] = await client.db
      .insert(organization)
      .values({ name, ownerId })
      .returning();
    await client.db.insert(organizationUser).values({ orgId: org!.id, userId: ownerId, role: 'OWNER' });
    return org!.id;
  }

  async function makeProject(orgId: string, ownerId: string, name: string) {
    const [row] = await client.db
      .insert(project)
      .values({ orgId, name, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    ownerA = await makeUser('owner-a');
    memberA = await makeUser('member-a');
    ownerB = await makeUser('owner-b');
    orgA = await makeOrg('org-a', ownerA);
    orgB = await makeOrg('org-b', ownerB);
    await client.db.insert(organizationUser).values({ orgId: orgA, userId: memberA, role: 'MEMBER' });
    projectA = await makeProject(orgA, ownerA, 'alpha');
    projectB = await makeProject(orgB, ownerB, 'beta');
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('assignee round-trips through create and the assignee-filtered read', async () => {
    const created = await repo.create({
      projectId: projectA,
      title: 'intern task',
      isHumanTask: true,
      assignee: memberA,
      createdBy: ownerA,
    });
    expect(created.assignee).toBe(memberA);

    // "My tasks": findForOrg with the assignee filter returns it…
    const mine = await repo.findForOrg(orgA, { skip: 0, limit: 20, assigneeId: memberA });
    expect(mine.data.map((t) => t.id)).toEqual([created.id]);

    // …and the owner (not the assignee) filtered by their own id sees nothing.
    const ownersOwn = await repo.findForOrg(orgA, { skip: 0, limit: 20, assigneeId: ownerA });
    expect(ownersOwn.data).toHaveLength(0);
  });

  it('the assignee filter is org-scoped: org B cannot read org A’s assignments', async () => {
    await repo.create({
      projectId: projectA,
      title: 'org A intern task',
      isHumanTask: true,
      assignee: memberA,
      createdBy: ownerA,
    });

    // Org B, even filtering by org A's member id, sees none of org A's rows —
    // the assignee filter never widens the tenant boundary (project join).
    const leaked = await repo.findForOrg(orgB, { skip: 0, limit: 20, assigneeId: memberA });
    expect(leaked.data).toHaveLength(0);
  });

  it('assignment writes are org-scoped: a foreign org cannot (re)assign the task', async () => {
    const created = await repo.create({
      projectId: projectA,
      title: 'unassigned',
      isHumanTask: true,
      createdBy: ownerA,
    });
    expect(created.assignee).toBeNull();

    // Org B trying to write org A's task updates zero rows (orgGuard subquery).
    const foreign = await repo.update(created.id, orgB, { assignee: memberA });
    expect(foreign).toBeNull();

    // The owning org assigns and unassigns cleanly.
    const assigned = await repo.update(created.id, orgA, { assignee: memberA });
    expect(assigned?.assignee).toBe(memberA);
    const cleared = await repo.update(created.id, orgA, { assignee: null });
    expect(cleared?.assignee).toBeNull();
    expect(projectB).toBeDefined();
  });
});
