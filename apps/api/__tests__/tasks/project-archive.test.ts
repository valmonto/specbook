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
import { ProjectRepository } from '@/tasks/project.repository.js';

/**
 * The name boundary and the archive boundary, proven against the real
 * database: the partial unique index on (org_id, lower(name)) binds live
 * projects per org — case-insensitively — while archiving both frees the
 * name and removes the project from the default listing. Two orgs prove
 * the namespace is per-tenant.
 */
describeIntegration('ProjectRepository — unique names and the archive boundary', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new ProjectRepository(client);

  let orgA: string;
  let orgB: string;
  let ownerA: string;
  let ownerB: string;

  /** The driver wraps the pg error — the constraint name lives down the
   *  cause chain, the same walk ProjectService's isNameCollision does. */
  function isNameCollision(error: unknown): boolean {
    for (
      let e = error as
        | { code?: string; constraint?: string; constraint_name?: string; cause?: unknown }
        | undefined;
      e;
      e = e.cause as typeof e
    ) {
      if (
        e.code === '23505' &&
        (e.constraint === 'project_org_name_active_uq' ||
          e.constraint_name === 'project_org_name_active_uq')
      ) {
        return true;
      }
    }
    return false;
  }

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

  beforeEach(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    ownerB = b.ownerId;
  });

  afterAll(async () => {
    await truncate(client.db, [task, project, organizationUser, organization, user]);
    await client.close();
  });

  it('rejects a duplicate live name in the same org — case-insensitively', async () => {
    await repo.create({ orgId: orgA, name: 'Testino', createdBy: ownerA });
    const err = await repo
      .create({ orgId: orgA, name: 'testino', createdBy: ownerA })
      .then(() => null, (e: unknown) => e);
    expect(isNameCollision(err)).toBe(true);
  });

  it('the namespace is per-org: another tenant reuses the name freely', async () => {
    await repo.create({ orgId: orgA, name: 'Testino', createdBy: ownerA });
    await expect(
      repo.create({ orgId: orgB, name: 'Testino', createdBy: ownerB }),
    ).resolves.toMatchObject({ name: 'Testino' });
  });

  it('archiving frees the name and leaves the default listing; unarchive into a collision fails', async () => {
    const first = await repo.create({ orgId: orgA, name: 'Testino', createdBy: ownerA });
    await repo.update(first.id, orgA, { archivedAt: new Date() });

    // Name is free again for a live project…
    const second = await repo.create({ orgId: orgA, name: 'Testino', createdBy: ownerA });

    // …the default listing shows only the live one, the archived listing only the other.
    const live = await repo.findForOrg(orgA, { skip: 0, limit: 10 });
    expect(live.data.map((p) => p.id)).toEqual([second.id]);
    const archived = await repo.findForOrg(orgA, { skip: 0, limit: 10, archived: true });
    expect(archived.data.map((p) => p.id)).toEqual([first.id]);

    // …and restoring the archived twin collides with the live claim.
    const err = await repo
      .update(first.id, orgA, { archivedAt: null })
      .then(() => null, (e: unknown) => e);
    expect(isNameCollision(err)).toBe(true);
  });
});
