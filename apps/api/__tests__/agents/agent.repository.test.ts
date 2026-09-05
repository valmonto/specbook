import {
  createDatabaseClient,
  agent,
  apiKey,
  organization,
  organizationUser,
  project,
  task,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { AgentRepository } from '@/agents/agent.repository.js';

/**
 * The tenancy boundary on agents, proven against the real database: listing
 * and claim resolution are org-scoped in both directions.
 */
describeIntegration('AgentRepository — two-tenant boundary', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new AgentRepository(client);

  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let keyA: string;
  let keyB: string;

  const tables = [task, agent, apiKey, project, organizationUser, organization, user];

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
    const [key] = await client.db
      .insert(apiKey)
      .values({
        name: `${name}-key`,
        prefix: 'sk_test',
        hashedKey: `h-${name}-${Date.now()}`,
        scopes: ['tasks:agent'],
        userId: owner!.id,
        orgId: org!.id,
      })
      .returning();
    return { orgId: org!.id, userId: owner!.id, keyId: key!.id };
  }

  beforeEach(async () => {
    await truncate(client.db, tables);
    const a = await makeOrg('agents-a');
    const b = await makeOrg('agents-b');
    orgA = a.orgId;
    userA = a.userId;
    keyA = a.keyId;
    orgB = b.orgId;
    userB = b.userId;
    keyB = b.keyId;
  });

  afterAll(async () => {
    await truncate(client.db, tables);
    await client.close();
  });

  it('listForOrg sees only the org’s own agents', async () => {
    await repo.create({ orgId: orgA, name: 'a-runner', apiKeyId: keyA, kind: 'external' });
    await repo.create({ orgId: orgB, name: 'b-runner', apiKeyId: keyB, kind: 'external' });

    const forA = await repo.listForOrg(orgA);
    expect(forA.map((r) => r.name)).toEqual(['a-runner']);
    const forB = await repo.listForOrg(orgB);
    expect(forB.map((r) => r.name)).toEqual(['b-runner']);
  });

  it('update is org-keyed: another org cannot write the row', async () => {
    const mine = await repo.create({
      orgId: orgA,
      name: 'a-runner',
      apiKeyId: keyA,
      kind: 'external',
    });
    expect(await repo.update(mine.id, orgB, { status: 'error' })).toBeNull();
    const [still] = await repo.listForOrg(orgA);
    expect(still!.status).toBe('offline');
  });

  it('currentClaim resolves through the owning org only', async () => {
    const [projA] = await client.db
      .insert(project)
      .values({ orgId: orgA, name: 'proj-a', createdBy: userA })
      .returning();
    await client.db.insert(task).values({
      projectId: projA!.id,
      title: 'claimed work',
      status: 'in_progress',
      claimedBy: userA,
      claimedAt: new Date(),
      createdBy: userA,
    });

    expect((await repo.currentClaim(userA, orgA))?.title).toBe('claimed work');
    // The same user id asked through org B's lens finds nothing.
    expect(await repo.currentClaim(userA, orgB)).toBeNull();
    expect(await repo.currentClaim(userB, orgB)).toBeNull();
  });
});
