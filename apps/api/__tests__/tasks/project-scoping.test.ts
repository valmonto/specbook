import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  projectMember,
  task,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ProjectRepository } from '@/tasks/project.repository.js';
import { ProjectMemberRepository } from '@/tasks/project-member.repository.js';
import { TaskRepository } from '@/tasks/task.repository.js';

/**
 * The per-project visibility boundary — the load-bearing test for
 * feat/project-scoping. TWO MEMBERS in ONE org, each granted a DIFFERENT
 * project, prove the plane below org membership:
 *
 *   - a restricted MEMBER granted project A cannot read project B by ANY read
 *     path — the project list, a direct project :id, the task list, a direct
 *     task :id, and the task-subject resolver that gates attachment reads
 *     (list / read-url) — while the member granted B can;
 *   - OWNER/ADMIN and AGENT identities (restrictMemberId = undefined) see
 *     EVERYTHING, so the dispatch runner never goes blind;
 *   - the org boundary still holds beneath the project plane (a second org is
 *     never visible, grant or no grant);
 *   - the assignment gate (canAccessProject) admits only users who can see the
 *     project.
 *
 * `restrictMemberId` present is exactly what the services derive from a human
 * MEMBER via isProjectScopedIdentity; undefined is what OWNER/ADMIN and agents
 * (isAgent) get — so these repository assertions are the real enforcement.
 */
describeIntegration('project visibility scoping — the two-member boundary', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const projects = new ProjectRepository(client);
  const tasks = new TaskRepository(client);
  const members = new ProjectMemberRepository(client);

  let orgA: string;
  let orgB: string;
  let owner: string; // OWNER of orgA — all-access
  let memberA: string; // MEMBER of orgA, granted projectA only
  let memberB: string; // MEMBER of orgA, granted projectB only
  let stranger: string; // MEMBER of orgA, granted nothing
  let projectA: string;
  let projectB: string;
  let taskA: string;
  let taskB: string;
  let ownerB: string;
  let projectOtherOrg: string;

  async function makeUser(name: string) {
    const [u] = await client.db
      .insert(user)
      .values({ email: `${name}@example.com`, name, passwordHash: 'x' })
      .returning();
    return u!.id;
  }

  async function makeOrg(name: string, ownerId: string) {
    const [org] = await client.db.insert(organization).values({ name, ownerId }).returning();
    await client.db
      .insert(organizationUser)
      .values({ orgId: org!.id, userId: ownerId, role: 'OWNER' });
    return org!.id;
  }

  async function addMember(orgId: string, userId: string) {
    await client.db.insert(organizationUser).values({ orgId, userId, role: 'MEMBER' });
  }

  async function makeProject(orgId: string, ownerId: string, name: string) {
    const [row] = await client.db
      .insert(project)
      .values({ orgId, name, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  async function makeTask(projectId: string, ownerId: string, title: string) {
    const [row] = await client.db
      .insert(task)
      .values({ projectId, title, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [projectMember, task, project, organizationUser, organization, user]);
    owner = await makeUser('owner');
    memberA = await makeUser('member-a');
    memberB = await makeUser('member-b');
    stranger = await makeUser('stranger');
    ownerB = await makeUser('owner-b');

    orgA = await makeOrg('org-a', owner);
    orgB = await makeOrg('org-b', ownerB);
    await addMember(orgA, memberA);
    await addMember(orgA, memberB);
    await addMember(orgA, stranger);

    projectA = await makeProject(orgA, owner, 'alpha');
    projectB = await makeProject(orgA, owner, 'beta');
    projectOtherOrg = await makeProject(orgB, ownerB, 'gamma');
    taskA = await makeTask(projectA, owner, 'task in A');
    taskB = await makeTask(projectB, owner, 'task in B');

    await members.grant(orgA, projectA, memberA, owner);
    await members.grant(orgA, projectB, memberB, owner);
  });

  afterAll(async () => {
    await truncate(client.db, [projectMember, task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('deny-by-default: a member with no grants sees no projects', async () => {
    const { data, total } = await projects.findForOrg(orgA, { skip: 0, limit: 50 }, stranger);
    expect(data).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('the project list is scoped: each member sees only their granted project', async () => {
    const a = await projects.findForOrg(orgA, { skip: 0, limit: 50 }, memberA);
    expect(a.data.map((p) => p.id)).toEqual([projectA]);

    const b = await projects.findForOrg(orgA, { skip: 0, limit: 50 }, memberB);
    expect(b.data.map((p) => p.id)).toEqual([projectB]);
  });

  it('a direct project :id does not leak across the grant', async () => {
    // Granted → visible; ungranted → behaves exactly like a missing project.
    expect(await projects.findById(projectA, orgA, memberA)).not.toBeNull();
    expect(await projects.findById(projectB, orgA, memberA)).toBeNull();
    expect(await projects.findById(projectA, orgA, memberB)).toBeNull();
    expect(await projects.findById(projectB, orgA, memberB)).not.toBeNull();
  });

  it('the task list is scoped through the owning project', async () => {
    const a = await tasks.findForOrg(orgA, { skip: 0, limit: 50 }, memberA);
    expect(a.data.map((t) => t.id)).toEqual([taskA]);

    const b = await tasks.findForOrg(orgA, { skip: 0, limit: 50 }, memberB);
    expect(b.data.map((t) => t.id)).toEqual([taskB]);
  });

  it('a direct task :id does not leak, and neither does the attachment subject resolver', async () => {
    // The attachment list / read-url paths gate on exactly this call (the
    // injected `task` subject resolver runs tasks.findById with the member
    // scope). So a null here IS the closed attachment leak.
    expect(await tasks.findById(taskA, orgA, memberA)).not.toBeNull();
    expect(await tasks.findById(taskB, orgA, memberA)).toBeNull();
    expect(await tasks.findById(taskA, orgA, memberB)).toBeNull();
    expect(await tasks.findById(taskB, orgA, memberB)).not.toBeNull();
  });

  it('OWNER/ADMIN and AGENT identities (no restrict) see every project and task', async () => {
    // restrictMemberId undefined is what OWNER/ADMIN and agents (isAgent) get —
    // the runner must see both projects to dispatch.
    const allProjects = await projects.findForOrg(orgA, { skip: 0, limit: 50 });
    expect(allProjects.data.map((p) => p.id).sort()).toEqual([projectA, projectB].sort());
    expect(await projects.findById(projectB, orgA)).not.toBeNull();

    const allTasks = await tasks.findForOrg(orgA, { skip: 0, limit: 50 });
    expect(allTasks.data.map((t) => t.id).sort()).toEqual([taskA, taskB].sort());
    expect(await tasks.findById(taskB, orgA)).not.toBeNull();
  });

  it('the org boundary still holds beneath the project plane', async () => {
    // memberA of orgA sees nothing in orgB, even unrestricted — a grant can
    // never widen the tenant.
    const foreign = await projects.findForOrg(orgB, { skip: 0, limit: 50 }, memberA);
    expect(foreign.data).toHaveLength(0);
    expect(await projects.findById(projectOtherOrg, orgA, memberA)).toBeNull();
    expect(await projects.findById(projectOtherOrg, orgA)).toBeNull();
  });

  it('the assignment gate admits only users who can see the project', async () => {
    // Owner sees all; memberA only A; memberB only B; a non-member never.
    expect(await members.canAccessProject(orgA, projectA, owner)).toBe(true);
    expect(await members.canAccessProject(orgA, projectB, owner)).toBe(true);
    expect(await members.canAccessProject(orgA, projectA, memberA)).toBe(true);
    expect(await members.canAccessProject(orgA, projectB, memberA)).toBe(false);
    expect(await members.canAccessProject(orgA, projectA, memberB)).toBe(false);
    expect(await members.canAccessProject(orgA, projectA, stranger)).toBe(false);
    // A user from another org is not assignable here at all.
    expect(await members.canAccessProject(orgA, projectA, ownerB)).toBe(false);
  });

  it('revoke removes visibility; grant is idempotent; listForProject reflects both', async () => {
    let list = await members.listForProject(orgA, projectA);
    expect(list.map((m) => m.userId)).toEqual([memberA]);
    expect(list[0]!.orgRole).toBe('MEMBER');

    // Idempotent re-grant: still exactly one row.
    await members.grant(orgA, projectA, memberA, owner);
    list = await members.listForProject(orgA, projectA);
    expect(list).toHaveLength(1);

    // Revoke → the member loses the project on every path.
    expect(await members.revoke(orgA, projectA, memberA)).toBe(true);
    expect(await projects.findById(projectA, orgA, memberA)).toBeNull();
    expect(await tasks.findById(taskA, orgA, memberA)).toBeNull();
    expect(await members.listForProject(orgA, projectA)).toHaveLength(0);
  });

  it('isOrgMember reflects org membership only', async () => {
    expect(await members.isOrgMember(orgA, memberA)).toBe(true);
    expect(await members.isOrgMember(orgA, ownerB)).toBe(false);
  });
});
