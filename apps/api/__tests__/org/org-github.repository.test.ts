import {
  createDatabaseClient,
  organization,
  organizationUser,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { OrgRepository } from '@/org/org.repository';

/**
 * The GitHub installation column is the tenancy boundary of the whole
 * integration — later tickets mint repo-scoped credentials from it. A real
 * database is the only place to prove one org's connection can never be read
 * or written through another org's id.
 */
describeIntegration('OrgRepository — GitHub connection', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repository = new OrgRepository(client);

  let orgA: string;
  let orgB: string;

  async function makeOrg(name: string): Promise<string> {
    const [owner] = await client.db
      .insert(user)
      .values({ email: `${name}-owner@example.com`, name: `${name} owner`, passwordHash: 'x' })
      .returning();

    const [org] = await client.db
      .insert(organization)
      .values({ name, ownerId: owner!.id })
      .returning();

    await client.db
      .insert(organizationUser)
      .values({ orgId: org!.id, userId: owner!.id, role: 'OWNER' });

    return org!.id;
  }

  beforeEach(async () => {
    await truncate(client.db, [organizationUser, organization, user]);
    orgA = await makeOrg('org-a');
    orgB = await makeOrg('org-b');
  });

  afterAll(async () => {
    await truncate(client.db, [organizationUser, organization, user]);
    await client.close();
  });

  it('a connection written to org A is invisible through org B, both directions', async () => {
    await repository.setGithubConnection(orgA, {
      installationId: 777,
      accountLogin: 'valmonto',
      connectedAt: new Date(),
    });

    const a = await repository.findGithubConnection(orgA);
    expect(a?.installationId).toBe(777);
    expect(a?.accountLogin).toBe('valmonto');

    await expect(repository.findGithubConnection(orgB)).resolves.toBeNull();

    // And the reverse: connecting B does not disturb A's record.
    await repository.setGithubConnection(orgB, {
      installationId: 888,
      accountLogin: 'other-org',
      connectedAt: new Date(),
    });
    await expect(repository.findGithubConnection(orgA)).resolves.toMatchObject({
      installationId: 777,
    });
  });

  it('clearing org A leaves org B connected', async () => {
    await repository.setGithubConnection(orgA, {
      installationId: 777,
      accountLogin: 'valmonto',
      connectedAt: new Date(),
    });
    await repository.setGithubConnection(orgB, {
      installationId: 888,
      accountLogin: 'other-org',
      connectedAt: new Date(),
    });

    await repository.clearGithubConnection(orgA);

    await expect(repository.findGithubConnection(orgA)).resolves.toBeNull();
    await expect(repository.findGithubConnection(orgB)).resolves.toMatchObject({
      installationId: 888,
    });
  });

  it('an unconnected org reads as null, not a half-empty record', async () => {
    await expect(repository.findGithubConnection(orgA)).resolves.toBeNull();
  });
});
