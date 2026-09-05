import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  createDatabaseClient,
  dataAccessAudit,
  deployment,
  organization,
  organizationUser,
  project,
  projectEnvironment,
  server,
  user,
  type DatabaseClient,
} from '@pkg/database';
import type { ActiveUser } from '@pkg/contracts';
import {
  SecretsService,
  type DeploymentProducer,
  type EnvironmentProvisionProducer,
  type SshService,
} from '@pkg/server';
import { describeIntegration, FakeLogger, truncate } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { DataPlaneExecutor } from '@/data-plane/data-plane.executor.js';
import { EnvironmentRepository } from '@/environments/environment.repository.js';
import { EnvironmentService } from '@/environments/environment.service.js';

/**
 * The grant + audit model against the real database: shipping the columns
 * opens nothing (every row is 'none'), a window opened by a human is what
 * the executor honours, and the audit answers "who read what, when" — inside
 * the org, and after the environment itself is gone.
 */
describeIntegration('Agent data-plane access — grant columns + audit', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new EnvironmentRepository(client);
  const secrets = new SecretsService({
    get: () => randomBytes(32).toString('base64'),
  } as unknown as ConfigService);
  const service = new EnvironmentService(
    repo,
    secrets,
    {
      enqueueProvision: vi.fn(),
      enqueueDeprovision: vi.fn(),
    } as unknown as EnvironmentProvisionProducer,
    { enqueueDeploy: vi.fn() } as unknown as DeploymentProducer,
    new FakeLogger().as<PinoLogger>(),
  );
  const ssh = { exec: vi.fn().mockResolvedValue('[{"n":1}]\n') };
  const executor = new DataPlaneExecutor(
    repo,
    secrets,
    ssh as unknown as SshService,
    new FakeLogger().as<PinoLogger>(),
  );

  let orgA: string;
  let orgB: string;
  let projectA: string;
  let ownerA: string;
  let serverA: string;

  const actorA = (): ActiveUser => ({
    userId: ownerA,
    orgId: orgA,
    orgRole: 'OWNER',
    systemRole: 'USER',
  });
  const actorB = (): ActiveUser => ({
    userId: 'ub',
    orgId: orgB,
    orgRole: 'OWNER',
    systemRole: 'USER',
  });
  const caller = { keyId: null as unknown as string, name: 'runner' };

  async function makeOrg(name: string) {
    const [owner] = await client.db
      .insert(user)
      .values({ email: `${name}@example.com`, name: `${name} owner`, passwordHash: 'x' })
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
        roles: ['app', 'data'],
        publicKey: 'ssh-ed25519 AAAA test',
        privateKeyEnc: secrets.seal('key-material'),
        createdBy: owner!.id,
      })
      .returning();
    return { orgId: org!.id, projectId: proj!.id, ownerId: owner!.id, serverId: srv!.id };
  }

  const tables = [
    dataAccessAudit,
    deployment,
    projectEnvironment,
    server,
    project,
    organizationUser,
    organization,
    user,
  ];

  beforeEach(async () => {
    await truncate(client.db, tables);
    ssh.exec.mockClear();
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    orgA = a.orgId;
    projectA = a.projectId;
    ownerA = a.ownerId;
    serverA = a.serverId;
    orgB = b.orgId;
  });

  afterAll(async () => {
    await truncate(client.db, tables);
    await client.close();
  });

  it("a new environment is 'none' — shipping the feature opens nothing", async () => {
    const env = await repo.create({ projectId: projectA, name: 'staging', serverId: serverA });
    expect(env.mcpAccess).toBe('none');
    expect(env.mcpAccessUntil).toBeNull();
    const [dto] = (await service.list(actorA(), projectA)).data;
    expect(dto).toMatchObject({ mcpAccess: 'none', mcpAccessUntil: null, mcpAccessByName: null });
  });

  it('grant → executor allowed → revoke → executor denied, each step audited with who/when', async () => {
    const env = await repo.create({
      projectId: projectA,
      name: 'staging',
      serverId: serverA,
      provisionStatus: 'provisioned',
      platformEnv: { DATABASE_URL: 'postgresql://x:y@specbook-postgres:5432/x' },
    });

    // Closed: denied and audited.
    await expect(
      executor.execute(actorA(), caller, {
        resource: 'database',
        projectId: projectA,
        environment: 'staging',
        sql: 'SELECT 1',
      }),
    ).rejects.toThrow('environments.errors.mcpAccessDenied');

    // A human opens the window.
    const opened = await service.grantMcpAccess(actorA(), {
      projectId: projectA,
      id: env.id,
      mode: 'read',
      minutes: 30,
      reason: 'debugging the migration',
    });
    expect(opened.mcpAccess).toBe('read');
    expect(opened.mcpAccessBy).toBe(ownerA);
    expect(opened.mcpAccessByName).toBe('org-a owner');
    expect(new Date(opened.mcpAccessUntil!).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);

    const result = await executor.execute(actorA(), caller, {
      resource: 'database',
      projectId: projectA,
      environment: 'staging',
      sql: 'SELECT 1 AS n',
    });
    expect(result).toMatchObject({ ok: true, data: { rows: [{ n: 1 }] } });
    expect(ssh.exec).toHaveBeenCalledTimes(1);

    // Revoke closes it immediately.
    const closed = await service.revokeMcpAccess(actorA(), { projectId: projectA, id: env.id });
    expect(closed).toMatchObject({ mcpAccess: 'none', mcpAccessUntil: null, mcpAccessBy: null });
    await expect(
      executor.execute(actorA(), caller, {
        resource: 'database',
        projectId: projectA,
        environment: 'staging',
        sql: 'SELECT 1',
      }),
    ).rejects.toThrow('environments.errors.mcpAccessDenied');

    const { data: audit } = await service.listAccessAudit(actorA(), {
      projectId: projectA,
      id: env.id,
    });
    expect(audit.map((a) => `${a.resource}:${a.operation}:${a.outcome}`)).toEqual([
      'database:sql:denied',
      'grant:revoke:allowed',
      'database:sql:allowed',
      'grant:grant:allowed',
      'database:sql:denied',
    ]);
    const grantRow = audit.find((a) => a.operation === 'grant')!;
    expect(grantRow.userId).toBe(ownerA);
    expect(grantRow.detail).toBe('debugging the migration');
    const readRow = audit.find((a) => a.outcome === 'allowed' && a.resource === 'database')!;
    expect(readRow.target).toBe('SELECT 1 AS n');
    expect(readRow.agentName).toBe('runner');
  });

  it('the audit is org-scoped and OUTLIVES the environment (link nulled, names kept)', async () => {
    const env = await repo.create({ projectId: projectA, name: 'staging', serverId: serverA });
    await service.grantMcpAccess(actorA(), {
      projectId: projectA,
      id: env.id,
      mode: 'read',
      minutes: 10,
    });

    // Foreign org: the environment does not exist for it, so neither does its audit.
    await expect(
      service.listAccessAudit(actorB(), { projectId: projectA, id: env.id }),
    ).rejects.toThrow('tasks.errors.projectNotFound');

    await repo.delete(env.id, projectA);
    const rows = await client.db.select().from(dataAccessAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: orgA,
      environmentId: null,
      projectName: 'org-a-project',
      environmentName: 'staging',
      operation: 'grant',
    });
  });

  it('the mcp_access CHECK refuses values outside the vocabulary', async () => {
    await expect(
      repo.create({ projectId: projectA, name: 'staging', serverId: serverA, mcpAccess: 'root' }),
    ).rejects.toThrow();
  });
});
