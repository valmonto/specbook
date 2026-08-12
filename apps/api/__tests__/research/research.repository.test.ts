import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  research,
  researchMessage,
  task,
  user,
  eq,
  type DatabaseClient,
} from '@pkg/database';
import type { ActiveUser } from '@pkg/contracts';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ResearchRepository } from '@/research/research.repository';
import { ResearchService } from '@/research/research.service';
import { ProjectRepository } from '@/tasks/project.repository';
import { TaskRepository } from '@/tasks/task.repository';

/**
 * Research tenancy, keyset pagination and the ticket-cut lineage, proven
 * against the real database. Two orgs prove every read/write/append/cut stays
 * inside the organization; a keyset window proves stability across inserts.
 */
describeIntegration('ResearchRepository — tenancy, keyset paging and cut lineage', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new ResearchRepository(client);

  // cutTickets and appendMessage are service logic; a real service over real
  // repositories does the org scoping (the logger is an inert stub).
  const taskRepo = new TaskRepository(client);
  const service = new ResearchService(
    repo,
    new ProjectRepository(client),
    taskRepo,
    { info: () => {}, warn: () => {}, error: () => {} } as never,
  );

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let ownerB: string;
  let projectA: string;

  const actorA = (): ActiveUser => ({
    userId: ownerA,
    orgId: orgA,
    orgRole: 'OWNER',
    systemRole: 'USER',
  });
  const actorB = (): ActiveUser => ({
    userId: ownerB,
    orgId: orgB,
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

  async function makeProject(orgId: string, ownerId: string, name: string) {
    const [row] = await client.db
      .insert(project)
      .values({ orgId, name, createdBy: ownerId })
      .returning();
    return row!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [
      researchMessage,
      task,
      research,
      project,
      organizationUser,
      organization,
      user,
    ]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    ownerB = b.ownerId;
    projectA = await makeProject(orgA, ownerA, 'alpha');
  });

  afterAll(async () => {
    await truncate(client.db, [
      researchMessage,
      task,
      research,
      project,
      organizationUser,
      organization,
      user,
    ]);
    await client.close();
  });

  const seed = (orgId: string, ownerId: string, title: string, projectId: string | null = null) =>
    repo.create({ orgId, projectId, title, createdBy: ownerId });

  it('two-tenant isolation: a foreign org lists, reads, appends and cuts NOTHING', async () => {
    const doc = await seed(orgA, ownerA, 'A private', projectA);
    await repo.createMessage({
      researchId: doc.id,
      orgId: orgA,
      authorId: ownerA,
      authorType: 'user',
      body: 'first',
    });

    // List: org B sees none of org A's documents.
    expect((await repo.list(orgB, { limit: 20 })).data).toEqual([]);
    // Read: a foreign id is indistinguishable from missing.
    expect(await repo.findById(doc.id, orgB)).toBeNull();
    // Messages: org B reads nothing.
    expect((await repo.listMessages(doc.id, orgB, { limit: 20 })).data).toEqual([]);
    // Append (service): a foreign org cannot append — and adds no message.
    await expect(service.appendMessage(actorB(), { id: doc.id, body: 'x' })).rejects.toThrow();
    expect((await repo.listMessages(doc.id, orgA, { limit: 20 })).data).toHaveLength(1);
    // Cut (service): a foreign org cannot cut — and creates no task.
    await expect(
      service.cutTickets(actorB(), { id: doc.id, proposals: [{ title: 't' }] }),
    ).rejects.toThrow();
    expect(await client.db.select().from(task)).toHaveLength(0);

    // The owner still sees its own document.
    expect((await repo.list(orgA, { limit: 20 })).data.map((r) => r.title)).toEqual(['A private']);
  });

  it('keyset pagination is stable across inserts', async () => {
    const first: string[] = [];
    for (let i = 1; i <= 5; i++) first.push((await seed(orgA, ownerA, `r${i}`)).id);
    // Newest first (updated_at desc, id desc) → r5, r4, r3, r2, r1.

    const page1 = await repo.list(orgA, { limit: 2 });
    expect(page1.data.map((r) => r.title)).toEqual(['r5', 'r4']);
    expect(page1.nextCursor).not.toBeNull();

    // Insert two NEWER rows — they land at the head, not inside the window.
    await seed(orgA, ownerA, 'r6');
    await seed(orgA, ownerA, 'r7');

    // Page 2 resumes from the cursor, unaffected by the head inserts.
    const page2 = await repo.list(orgA, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.data.map((r) => r.title)).toEqual(['r3', 'r2']);

    const page3 = await repo.list(orgA, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.data.map((r) => r.title)).toEqual(['r1']);
    expect(page3.nextCursor).toBeNull();
  });

  it('filters by project and by org-level scope, and by a title query', async () => {
    await seed(orgA, ownerA, 'associated', projectA);
    await seed(orgA, ownerA, 'floating one');
    await seed(orgA, ownerA, 'floating two');

    const byProject = await repo.list(orgA, { limit: 20, projectId: projectA });
    expect(byProject.data.map((r) => r.title)).toEqual(['associated']);

    const orgLevel = await repo.list(orgA, { limit: 20, scope: 'org' });
    expect(orgLevel.data.map((r) => r.title).sort()).toEqual(['floating one', 'floating two']);

    const byQuery = await repo.list(orgA, { limit: 20, q: 'FLOATING' });
    expect(byQuery.data).toHaveLength(2);
  });

  it('filters by status (and no filter returns every status), org-scoped', async () => {
    await client.db.insert(research).values([
      { orgId: orgA, title: 'in-queue', status: 'researching', createdBy: ownerA },
      { orgId: orgA, title: 'in-review', status: 'needs_review', createdBy: ownerA },
      { orgId: orgA, title: 'done', status: 'accepted', createdBy: ownerA },
      { orgId: orgB, title: 'other-org-review', status: 'needs_review', createdBy: ownerB },
    ]);

    // No status filter → the org's docs across every status.
    const all = await repo.list(orgA, { limit: 20 });
    expect(all.data.map((r) => r.title).sort()).toEqual(['done', 'in-queue', 'in-review']);

    // A specific status → only that subset.
    const review = await repo.list(orgA, { limit: 20, status: 'needs_review' });
    expect(review.data.map((r) => r.title)).toEqual(['in-review']);

    // Org-scoped: org B's needs_review doc is invisible to org A's status query.
    expect(review.data.some((r) => r.title === 'other-org-review')).toBe(false);
    expect((await repo.list(orgB, { limit: 20, status: 'needs_review' })).data.map((r) => r.title)).toEqual([
      'other-org-review',
    ]);
  });

  it('cutTickets creates DRAFT tasks with lineage AND area, defaulting the target to the research project', async () => {
    const doc = await seed(orgA, ownerA, 'cuttable', projectA);
    const { taskIds } = await service.cutTickets(actorA(), {
      id: doc.id,
      proposals: [
        { title: 'first ticket', area: 'Onboarding' },
        { title: 'second ticket', context: 'why', area: 'Onboarding' },
        { title: 'no-area ticket' },
      ],
    });
    expect(taskIds).toHaveLength(3);

    const rows = await client.db.select().from(task).where(eq(task.sourceResearchId, doc.id));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('draft');
      expect(row.projectId).toBe(projectA); // defaulted to the research's project
      expect(row.sourceResearchId).toBe(doc.id); // existing lineage
      expect(row.createdBy).toBe(ownerA);
    }

    // The given area persists alongside the lineage; an unset area stays null.
    const areaByTitle = Object.fromEntries(rows.map((r) => [r.title, r.area]));
    expect(areaByTitle['first ticket']).toBe('Onboarding');
    expect(areaByTitle['second ticket']).toBe('Onboarding');
    expect(areaByTitle['no-area ticket']).toBeNull();

    // The area landed within the same tenant: the project's distinct-areas
    // read (org-scoped) surfaces it for org A, and nothing for org B.
    expect(await taskRepo.distinctAreas(orgA, projectA)).toEqual(['Onboarding']);
    expect(await taskRepo.distinctAreas(orgB, projectA)).toEqual([]);

    // The reverse lineage count is queryable and org-scoped.
    expect(await repo.countTasksCut(doc.id, orgA)).toBe(3);
    expect(await repo.countTasksCut(doc.id, orgB)).toBe(0);
  });

  it('cutTickets on an org-level document with no target project is rejected', async () => {
    const doc = await seed(orgA, ownerA, 'floating', null);
    await expect(
      service.cutTickets(actorA(), { id: doc.id, proposals: [{ title: 't' }] }),
    ).rejects.toThrow();
    expect(await client.db.select().from(task)).toHaveLength(0);
  });
});
