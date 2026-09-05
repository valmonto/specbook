import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  createDatabaseClient,
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
import { SecretsService, type DeploymentProducer, type EnvironmentProvisionProducer } from '@pkg/server';
import { describeIntegration, FakeLogger, truncate } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { EnvironmentRepository } from '@/environments/environment.repository.js';
import { EnvironmentService } from '@/environments/environment.service.js';

/**
 * The read-only deploy-diagnosis tools (get_environment / list_deployments)
 * proven against the real database: they stay INSIDE the org boundary and
 * NEVER carry a secret out. Secrets set here are unmistakable sentinels so a
 * leak is a substring match away.
 */
describeIntegration('MCP deploy diagnosis — org-scoped, secret-free', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });
  const repo = new EnvironmentRepository(client);
  const secrets = new SecretsService({
    get: () => randomBytes(32).toString('base64'),
  } as unknown as ConfigService);
  const service = new EnvironmentService(
    repo,
    secrets,
    { enqueueProvision: vi.fn(), enqueueDeprovision: vi.fn() } as unknown as EnvironmentProvisionProducer,
    { enqueueDeploy: vi.fn() } as unknown as DeploymentProducer,
    new FakeLogger().as<PinoLogger>(),
  );

  // Sentinel secret material — none of these strings may appear in any payload.
  const USER_ENV_SECRET = 'SUPER_SECRET_USER_VALUE_zzz';
  const PLATFORM_SECRET = 'PLATFORM_WIRING_SECRET_yyy';
  const PRIVATE_KEY = 'BEGIN-PRIVATE-KEY-SEALED-xxx';
  const DATA_ROOT = 'DATA_ROOT_ROOT_PASSWORD_www';

  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;
  let ownerA: string;
  let envA: string;

  const actorA = (): ActiveUser => ({ userId: ownerA, orgId: orgA, orgRole: 'MEMBER', systemRole: 'USER' });
  const actorB = (): ActiveUser => ({ userId: 'ub', orgId: orgB, orgRole: 'MEMBER', systemRole: 'USER' });

  async function makeOrg(name: string, withSecrets: boolean) {
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
        host: `${name}.example.com`,
        port: 2222,
        sshUser: 'deployer',
        roles: ['app'],
        publicKey: 'ssh-ed25519 AAAA test',
        privateKeyEnc: `v1:${PRIVATE_KEY}`,
        dataRootEnvEnc: `v1:${DATA_ROOT}`,
        createdBy: owner!.id,
      })
      .returning();
    const [env] = await client.db
      .insert(projectEnvironment)
      .values({
        projectId: proj!.id,
        name: 'staging',
        serverId: srv!.id,
        domain: 'stg.example.com',
        deployPath: '/srv/app',
        autoDeploy: true,
        provisionStatus: 'provisioned',
        provisionError: null,
        platformEnv: withSecrets
          ? { DATABASE_URL: PLATFORM_SECRET, PORT: '3000' }
          : {},
        userEnvEnc: withSecrets ? secrets.seal(JSON.stringify({ API_KEY: USER_ENV_SECRET })) : null,
      })
      .returning();
    return { orgId: org!.id, ownerId: owner!.id, projectId: proj!.id, envId: env!.id };
  }

  const tables = [deployment, projectEnvironment, server, project, organizationUser, organization, user];

  beforeEach(async () => {
    await truncate(client.db, tables);
    const a = await makeOrg('org-a', true);
    const b = await makeOrg('org-b', false);
    orgA = a.orgId;
    ownerA = a.ownerId;
    projectA = a.projectId;
    envA = a.envId;
    orgB = b.orgId;
    projectB = b.projectId;
  });

  afterAll(async () => {
    await truncate(client.db, tables);
    await client.close();
  });

  it('get_environment returns the environment + its server connection facts', async () => {
    const { data } = await service.agentGetEnvironments(actorA(), { projectId: projectA });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      name: 'staging',
      domain: 'stg.example.com',
      deployPath: '/srv/app',
      autoDeploy: true,
      provisionStatus: 'provisioned',
      provisionError: null,
      server: { name: 'org-a-box', host: 'org-a.example.com', sshUser: 'deployer', port: 2222 },
    });
  });

  it('get_environment NEVER serializes a secret (user env, platform env, private key, data root)', async () => {
    const result = await service.agentGetEnvironments(actorA(), { projectId: projectA });
    const json = JSON.stringify(result);
    for (const secret of [USER_ENV_SECRET, PLATFORM_SECRET, PRIVATE_KEY, DATA_ROOT]) {
      expect(json).not.toContain(secret);
    }
    // The sealed/secret column NAMES don't ride along either.
    for (const col of ['userEnvEnc', 'user_env_enc', 'platformEnv', 'platform_env', 'privateKeyEnc', 'private_key_enc', 'dataRootEnvEnc', 'data_root_env_enc']) {
      expect(json).not.toContain(col);
    }
  });

  it('get_environment is org-scoped: org B cannot read org A (project reads as absent)', async () => {
    await expect(service.agentGetEnvironments(actorB(), { projectId: projectA })).rejects.toThrow(
      'tasks.errors.projectNotFound',
    );
    // Org B reads its OWN project — its own env, its own server, never org A's.
    const { data } = await service.agentGetEnvironments(actorB(), { projectId: projectB });
    expect(data).toHaveLength(1);
    expect(data[0]!.server.host).toBe('org-b.example.com');
  });

  it('list_deployments returns newest-first and is org-scoped + secret-free', async () => {
    const base = Date.now();
    const shas = ['aaa111', 'bbb222', 'ccc333'];
    for (let i = 0; i < shas.length; i++) {
      await client.db.insert(deployment).values({
        environmentId: envA,
        sha: shas[i]!,
        status: 'failed',
        trigger: 'manual',
        phase: 'build',
        domain: 'stg.example.com',
        error: 'deployments.errors.buildFailed',
        log: `sensitive log ${PRIVATE_KEY}`,
        createdAt: new Date(base + i * 1000),
        createdBy: ownerA,
      });
    }

    const { data } = await service.agentListDeployments(actorA(), { projectId: projectA });
    expect(data.map((d) => d.sha)).toEqual(['ccc333', 'bbb222', 'aaa111']);
    expect(data[0]).toMatchObject({
      environmentName: 'staging',
      trigger: 'manual',
      status: 'failed',
      phase: 'build',
      domain: 'stg.example.com',
      error: 'deployments.errors.buildFailed',
    });
    // The scrubbed log blob (and the secret it might hold) never rides along.
    const json = JSON.stringify(data);
    expect(json).not.toContain(PRIVATE_KEY);
    expect(json).not.toContain('"log"');

    // Org B cannot see org A's runs.
    await expect(service.agentListDeployments(actorB(), { projectId: projectA })).rejects.toThrow(
      'tasks.errors.projectNotFound',
    );
    const foreign = await service.agentListDeployments(actorB(), { projectId: projectB });
    expect(foreign.data).toEqual([]);
  });

  it('list_deployments honors the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await client.db.insert(deployment).values({
        environmentId: envA,
        sha: `sha${i}`,
        status: 'healthy',
        createdAt: new Date(Date.now() + i * 1000),
        createdBy: ownerA,
      });
    }
    const { data } = await service.agentListDeployments(actorA(), { projectId: projectA, limit: 2 });
    expect(data).toHaveLength(2);
  });
});
