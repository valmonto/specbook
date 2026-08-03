import {
  createDatabaseClient,
  eq,
  organization,
  organizationUser,
  project,
  projectEnvironment,
  server,
  user,
  type DatabaseClient,
} from '@pkg/database';
import { describeIntegration, truncate } from '@pkg/testing';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { EnvironmentRepository } from '@/environments/environment.repository';

/**
 * The tenancy boundary on environments, proven against the real database.
 * Environments are only reachable THROUGH a project the org owns — a foreign
 * org's ids come back empty-handed on every path.
 */
describeIntegration('EnvironmentRepository — two-tenant boundary', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new EnvironmentRepository(client);

  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;
  let serverA: string;
  let serverB: string;

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
    const [proj] = await client.db
      .insert(project)
      .values({ orgId: org!.id, name: `${name}-project`, createdBy: owner!.id })
      .returning();
    const [srv] = await client.db
      .insert(server)
      .values({
        orgId: org!.id,
        name: `${name}-box`,
        host: 'example.com',
        roles: ['app'],
        publicKey: 'ssh-ed25519 AAAA test',
        privateKeyEnc: 'v1:sealed',
        createdBy: owner!.id,
      })
      .returning();
    return { orgId: org!.id, projectId: proj!.id, serverId: srv!.id };
  }

  const tables = [projectEnvironment, server, project, organizationUser, organization, user];

  beforeEach(async () => {
    await truncate(client.db, tables);
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    projectA = a.projectId;
    serverA = a.serverId;
    orgB = b.orgId;
    projectB = b.projectId;
    serverB = b.serverId;
  });

  afterAll(async () => {
    await truncate(client.db, tables);
    await client.close();
  });

  it('environments are only reachable through the owning org', async () => {
    const mine = await repo.create({ projectId: projectA, name: 'staging', serverId: serverA });
    await repo.create({ projectId: projectB, name: 'staging', serverId: serverB });

    // The org boundary lookups themselves refuse foreign ids.
    expect(await repo.findProject(projectA, orgB)).toBeNull();
    expect(await repo.findServer(serverA, orgB)).toBeNull();

    const listed = await repo.findForProject(projectA, orgA);
    expect(listed.map((e) => e.id)).toEqual([mine.id]);
    expect(listed[0]!.serverName).toBe('org-a-box');

    // Foreign org sees nothing through any join path.
    expect(await repo.findForProject(projectA, orgB)).toEqual([]);
    expect(await repo.findById(mine.id, projectA, orgB)).toBeNull();
  });

  it('(project, name) is unique; another project reuses the name freely', async () => {
    await repo.create({ projectId: projectA, name: 'staging', serverId: serverA });
    await expect(
      repo.create({ projectId: projectA, name: 'staging', serverId: serverA }),
    ).rejects.toThrow();
    await expect(
      repo.create({ projectId: projectB, name: 'staging', serverId: serverB }),
    ).resolves.toMatchObject({ name: 'staging' });
  });

  it('a server hosting environments cannot be deleted (FK RESTRICT)', async () => {
    await repo.create({ projectId: projectA, name: 'staging', serverId: serverA });
    await expect(client.db.delete(server).where(eq(server.id, serverA))).rejects.toThrow();
  });
});
