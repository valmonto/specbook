import {
  createDatabaseClient,
  organization,
  organizationUser,
  project,
  research,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ProjectRepository } from '@/tasks/project.repository.js';

/**
 * Research activity per project, proven against the real database.
 *
 * This exists to answer what task counts cannot: whether a project is still
 * ASKING anything. One project here shipped 39 tasks over four months and
 * never opened a single research document, and nothing on the board said so.
 *
 * Org-scoped like every other read: one organization's research activity must
 * never appear against another's project.
 */
describeIntegration('ProjectRepository — research activity', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new ProjectRepository(client);

  let orgA: string;
  let orgB: string;
  let projectA: string;
  let quietProjectA: string;
  let projectB: string;
  let ownerA: string;
  let ownerB: string;

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

  async function makeProject(orgId: string, createdBy: string, name: string) {
    const [row] = await client.db
      .insert(project)
      .values({ orgId, name, context: 'ctx', createdBy })
      .returning();
    return row!.id;
  }

  const addResearch = (
    orgId: string,
    projectId: string | null,
    status: string,
    title: string,
    createdBy: string,
  ) => client.db.insert(research).values({ orgId, projectId, title, status, createdBy });

  beforeEach(async () => {
    await truncate(client.db, [research, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    orgB = b.orgId;
    ownerA = a.ownerId;
    ownerB = b.ownerId;
    projectA = await makeProject(orgA, a.ownerId, 'alpha');
    quietProjectA = await makeProject(orgA, a.ownerId, 'quiet');
    projectB = await makeProject(orgB, b.ownerId, 'beta');
  });

  // The api/worker suites share one test database and run serialized, so a
  // suite that leaves rows behind breaks the NEXT one — research rows point at
  // `user`, and a later `delete from "user"` then fails on the foreign key.
  afterAll(async () => {
    await truncate(client.db, [research, project, organizationUser, organization, user]);
    await client.close?.();
  });

  it('counts documents per status and reports when one was last touched', async () => {
    await addResearch(orgA, projectA, 'researching', 'open question', ownerA);
    await addResearch(orgA, projectA, 'accepted', 'settled question', ownerA);
    await addResearch(orgA, projectA, 'accepted', 'another settled one', ownerA);

    const activity = await repo.researchActivityByProject(orgA);

    expect(activity.get(projectA)?.counts).toEqual({ researching: 1, accepted: 2 });
    expect(activity.get(projectA)?.lastActivityAt).toBeInstanceOf(Date);
  });

  /** The signal that matters: a project nobody has asked anything about. */
  it('reports nothing for a project with no research at all', async () => {
    await addResearch(orgA, projectA, 'researching', 'open question', ownerA);

    const activity = await repo.researchActivityByProject(orgA);

    expect(activity.has(quietProjectA)).toBe(false);
  });

  /** The tenancy boundary. */
  it('never reports another org’s research', async () => {
    await addResearch(orgB, projectB, 'accepted', 'b only', ownerB);

    const forA = await repo.researchActivityByProject(orgA);
    const forB = await repo.researchActivityByProject(orgB);

    expect(forA.has(projectB)).toBe(false);
    expect(forA.size).toBe(0);
    expect(forB.get(projectB)?.counts).toEqual({ accepted: 1 });
  });

  /** Org-level documents have no project and belong to no project row. */
  it('ignores research that is not attached to a project', async () => {
    await addResearch(orgA, null, 'researching', 'org-wide question', ownerA);

    const activity = await repo.researchActivityByProject(orgA);

    expect(activity.size).toBe(0);
  });
});
