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
import { TaskRepository } from '@/tasks/task.repository';

/**
 * The task `area` tag on the read/write path: a free-text feature label that
 * round-trips through create/update and reads, plus the distinct-areas read
 * that powers the form autocomplete and the board's group-by-area view. Two
 * orgs prove the distinct read stays inside the tenant.
 */
describeIntegration('TaskRepository — the area tag and distinct-areas read', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new TaskRepository(client);

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let projectA: string;
  let projectB: string;

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
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    projectA = await makeProject(orgA, ownerA, 'alpha');
    projectB = await makeProject(orgB, b.ownerId, 'beta');
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('area round-trips through create, read and update', async () => {
    const created = await repo.create({
      projectId: projectA,
      title: 'onboarding task',
      area: 'Onboarding',
      createdBy: ownerA,
    });
    expect(created.area).toBe('Onboarding');

    // findById (detail) and findForOrg (board) both carry it.
    const found = await repo.findById(created.id, orgA);
    expect(found?.area).toBe('Onboarding');
    const { data } = await repo.findForOrg(orgA, { skip: 0, limit: 20 });
    expect(data.find((t) => t.id === created.id)?.area).toBe('Onboarding');

    // Update re-tags it; clearing to null is a legal untag.
    const retagged = await repo.update(created.id, orgA, { area: 'Login' });
    expect(retagged?.area).toBe('Login');
    const cleared = await repo.update(created.id, orgA, { area: null });
    expect(cleared?.area).toBeNull();
  });

  it('distinctAreas returns a project’s areas most-used first, untagged excluded', async () => {
    await repo.create({ projectId: projectA, title: 't1', area: 'Login', createdBy: ownerA });
    await repo.create({ projectId: projectA, title: 't2', area: 'Login', createdBy: ownerA });
    await repo.create({ projectId: projectA, title: 't3', area: 'Onboarding', createdBy: ownerA });
    // An untagged task contributes no area.
    await repo.create({ projectId: projectA, title: 't4', createdBy: ownerA });

    const areas = await repo.distinctAreas(orgA, projectA);
    // Login (2) outranks Onboarding (1); the null area never appears.
    expect(areas).toEqual(['Login', 'Onboarding']);
  });

  it('distinctAreas is org-scoped: a foreign org sees nothing', async () => {
    await repo.create({ projectId: projectA, title: 'secret area', area: 'Billing', createdBy: ownerA });

    // Org B reading org A's project id resolves no areas (scoped through the
    // owning project), and its own empty project resolves none either.
    expect(await repo.distinctAreas(orgB, projectA)).toEqual([]);
    expect(await repo.distinctAreas(orgB, projectB)).toEqual([]);
  });
});
