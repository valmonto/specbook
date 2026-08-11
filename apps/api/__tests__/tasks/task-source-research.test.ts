import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  research,
  task,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { TaskRepository } from '@/tasks/task.repository';

/**
 * Research lineage on the task read path: a task cut from a research document
 * carries the source's TITLE, resolved via an org-scoped LEFT JOIN. Two orgs
 * prove the join stays inside the tenant; a directly-filed task proves the
 * null case.
 */
describeIntegration('TaskRepository — research lineage on the read path', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let projectA: string;

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

  async function makeResearch(orgId: string, ownerId: string, title: string) {
    const [row] = await client.db
      .insert(research)
      .values({ orgId, title, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  async function makeTask(
    projectId: string,
    createdBy: string,
    title: string,
    sourceResearchId: string | null,
  ) {
    const [row] = await client.db
      .insert(task)
      .values({ projectId, title, status: 'draft', createdBy, sourceResearchId })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [task, research, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    projectA = await makeProject(orgA, ownerA, 'alpha');
  });

  afterAll(async () => {
    await truncate(client.db, [task, research, project, organizationUser, organization, user]);
    await client.close();
  });

  it('a task cut from research carries the source title; a directly-filed task carries null', async () => {
    const researchId = await makeResearch(orgA, ownerA, 'Payments overhaul');
    const cutId = await makeTask(projectA, ownerA, 'cut ticket', researchId);
    const plainId = await makeTask(projectA, ownerA, 'filed directly', null);

    // findById resolves the joined title (and null for the sourceless task).
    const cut = await repo.findById(cutId, orgA);
    expect(cut?.sourceResearchId).toBe(researchId);
    expect(cut?.sourceResearchTitle).toBe('Payments overhaul');

    const plain = await repo.findById(plainId, orgA);
    expect(plain?.sourceResearchId).toBeNull();
    expect(plain?.sourceResearchTitle).toBeNull();

    // findForOrg (the board query) carries the title on the matching row.
    const { data } = await repo.findForOrg(orgA, { skip: 0, limit: 20 });
    const titles = Object.fromEntries(data.map((t) => [t.id, t.sourceResearchTitle]));
    expect(titles[cutId]).toBe('Payments overhaul');
    expect(titles[plainId]).toBeNull();
  });

  it('the lineage join stays inside the tenant: a foreign org resolves no title', async () => {
    const researchId = await makeResearch(orgA, ownerA, 'A private');
    const cutId = await makeTask(projectA, ownerA, 'cut ticket', researchId);

    // Org B cannot see org A's task at all (scoped through the project).
    expect(await repo.findById(cutId, orgB)).toBeNull();
    const { data } = await repo.findForOrg(orgB, { skip: 0, limit: 20 });
    expect(data).toEqual([]);
  });
});
