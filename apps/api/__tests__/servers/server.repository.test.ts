import {
  createDatabaseClient,
  organization,
  organizationUser,
  server,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ServerRepository } from '@/servers/server.repository.js';

/**
 * The tenancy boundary on the machine inventory, proven against the real
 * database: reads, writes and deletes never cross organizations, and the
 * per-org name index is case-insensitive.
 */
describeIntegration('ServerRepository — two-tenant boundary', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new ServerRepository(client);

  let orgA: string;
  let orgB: string;
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

  const spec = (orgId: string, createdBy: string, name = 'box-1') => ({
    orgId,
    name,
    host: 'example.com',
    roles: ['app'],
    publicKey: 'ssh-ed25519 AAAA test',
    privateKeyEnc: 'v1:sealed',
    createdBy,
  });

  beforeEach(async () => {
    await truncate(client.db, [server, organizationUser, organization, user]);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    ownerA = a.ownerId;
    orgB = b.orgId;
    ownerB = b.ownerId;
  });

  afterAll(async () => {
    await truncate(client.db, [server, organizationUser, organization, user]);
    await client.close();
  });

  it('lists, reads, updates and deletes stay inside the org', async () => {
    const mine = await repo.create(spec(orgA, ownerA));
    await repo.create(spec(orgB, ownerB, 'their-box'));

    const listed = await repo.findForOrg(orgA, { skip: 0, limit: 10 });
    expect(listed.data.map((s) => s.id)).toEqual([mine.id]);

    // Cross-tenant reads and writes come back empty-handed.
    expect(await repo.findById(mine.id, orgB)).toBeNull();
    expect(await repo.update(mine.id, orgB, { name: 'stolen' })).toBeNull();
    expect(await repo.delete(mine.id, orgB)).toBe(false);

    // The owner still holds the row untouched.
    const still = await repo.findById(mine.id, orgA);
    expect(still?.name).toBe('box-1');
  });

  it('server names are unique per org, case-insensitively; other orgs reuse freely', async () => {
    await repo.create(spec(orgA, ownerA, 'Builder'));
    await expect(repo.create(spec(orgA, ownerA, 'builder'))).rejects.toThrow();
    await expect(repo.create(spec(orgB, ownerB, 'Builder'))).resolves.toMatchObject({
      name: 'Builder',
    });
  });
});
