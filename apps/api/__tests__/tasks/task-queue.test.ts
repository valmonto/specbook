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
import { MERGE_DEBT_CAP } from '@pkg/contracts';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { TaskRepository } from '@/tasks/task.repository';

/**
 * The agent queue (`available: true`) under the merge-debt gate: a project
 * sitting on MERGE_DEBT_CAP approved (merged-pending) tasks stops feeding
 * the queue until it drains. Enforced in the repository query — the one
 * every runner uses — so this is where the proof lives. Two projects in the
 * same org prove the gate is per-project; a second org proves tenancy.
 */
describeIntegration('TaskRepository — the agent queue and its gates', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);

  let orgA: string;
  let orgB: string;
  let gatedProject: string;
  let freeProject: string;
  let ownerA: string;

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

  async function makeTask(projectId: string, createdBy: string, status: string, title: string) {
    const [row] = await client.db
      .insert(task)
      .values({ projectId, title, status, createdBy })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    orgB = b.orgId;
    ownerA = a.ownerId;
    gatedProject = await makeProject(orgA, a.ownerId, 'gated');
    freeProject = await makeProject(orgA, a.ownerId, 'free');
    // org B has its own ready work — must never leak into org A's queue.
    const projB = await makeProject(orgB, b.ownerId, 'other-tenant');
    await makeTask(projB, b.ownerId, 'ready', 'b-ready');
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  const queue = () => repo.findForOrg(orgA, { skip: 0, limit: 20, available: true });

  it('serves ready tasks and never another tenant’s', async () => {
    await makeTask(gatedProject, ownerA, 'ready', 'a-ready');
    const { data } = await queue();
    expect(data.map((t) => t.title)).toEqual(['a-ready']);
  });

  it('gates a project at MERGE_DEBT_CAP approved tasks — per project, and releases as the queue drains', async () => {
    await makeTask(gatedProject, ownerA, 'ready', 'gated-ready');
    await makeTask(freeProject, ownerA, 'ready', 'free-ready');
    const approved: string[] = [];
    for (let i = 0; i < MERGE_DEBT_CAP; i++) {
      approved.push(await makeTask(gatedProject, ownerA, 'approved', `approved-${i}`));
    }

    // At the cap: the gated project's ready work vanishes from the queue,
    // its sibling project is unaffected.
    let { data } = await queue();
    expect(data.map((t) => t.title)).toEqual(['free-ready']);

    // One merge lands (approved → done): the gate releases.
    await client.db.update(task).set({ status: 'done' }).where(eq(task.id, approved[0]!));
    ({ data } = await queue());
    expect(data.map((t) => t.title).sort()).toEqual(['free-ready', 'gated-ready']);
  });

  it('max_parallel serializes a project: at the cap its ready tasks vanish; a finished claim releases them', async () => {
    await client.db.update(project).set({ maxParallel: 1 }).where(eq(project.id, gatedProject));
    await makeTask(gatedProject, ownerA, 'ready', 'gated-ready');
    await makeTask(freeProject, ownerA, 'ready', 'free-ready');
    const claimed = await makeTask(gatedProject, ownerA, 'in_progress', 'claimed');

    let { data } = await queue();
    expect(data.map((t) => t.title)).toEqual(['free-ready']);

    await client.db.update(task).set({ status: 'done' }).where(eq(task.id, claimed));
    ({ data } = await queue());
    expect(data.map((t) => t.title).sort()).toEqual(['free-ready', 'gated-ready']);
  });

  it('a tripped circuit breaker (auto mode, red main) empties the project queue', async () => {
    await client.db
      .update(project)
      .set({ mode: 'auto', autoPausedAt: new Date() })
      .where(eq(project.id, gatedProject));
    await makeTask(gatedProject, ownerA, 'ready', 'gated-ready');
    await makeTask(freeProject, ownerA, 'ready', 'free-ready');

    let { data } = await queue();
    expect(data.map((t) => t.title)).toEqual(['free-ready']);

    await client.db.update(project).set({ autoPausedAt: null }).where(eq(project.id, gatedProject));
    ({ data } = await queue());
    expect(data.map((t) => t.title).sort()).toEqual(['free-ready', 'gated-ready']);
  });

  it('below the cap the gate is invisible', async () => {
    await makeTask(gatedProject, ownerA, 'ready', 'gated-ready');
    for (let i = 0; i < MERGE_DEBT_CAP - 1; i++) {
      await makeTask(gatedProject, ownerA, 'approved', `approved-${i}`);
    }
    const { data } = await queue();
    expect(data.map((t) => t.title)).toEqual(['gated-ready']);
  });
});
