import {
  createDatabaseClient,
  deployment,
  organization,
  organizationUser,
  project,
  projectEnvironment,
  server,
  user,
  eq,
  type DatabaseClient,
} from '@pkg/database';
import type { GithubAppService, SecretsService, SshService } from '@pkg/server';
import { FakeLogger, describeIntegration, truncate } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { DeploymentProcessor } from '@/queues/deployment/deployment.processor.js';

const disabledGithubApp = { enabled: false } as unknown as GithubAppService;
const secrets = { open: () => 'PRIVATE-KEY' } as unknown as SecretsService;

/**
 * `SEED_ON_STARTUP` is the app's one chance to create its owner account, so
 * the question that gates it has to be "has this app ever come up?" — not
 * "did we mint the runtime secrets on this run".
 *
 * Those came apart in production. Secrets are minted during `render`, which
 * runs BEFORE the stack starts, so a deploy that rendered and then died at
 * migrate consumed the flag. Every later run saw IAM_JWT_SECRET already set,
 * shipped no SEED_ON_STARTUP, and the environment went healthy with no owner
 * user — while its generated SEED_INITIAL_PASSWORD sat in the settings having
 * never been applied to anything. The only symptom was "invalid email or
 * password" on login, which accuses the credential instead of the account.
 */
describeIntegration('DeploymentProcessor — seeding the initial owner', () => {
  const client: DatabaseClient = createDatabaseClient({ url: process.env.DATABASE_URL! });

  const tables = [
    deployment,
    projectEnvironment,
    project,
    server,
    organizationUser,
    organization,
    user,
  ];

  let environmentId: string;
  let ownerId: string;

  // Worker suites share one database and run serialized; rows left behind here
  // break a sibling suite's truncate on a RESTRICT foreign key.
  afterAll(async () => {
    await truncate(client.db, tables);
  });

  beforeEach(async () => {
    await truncate(client.db, tables);
    const [owner] = await client.db
      .insert(user)
      .values({ email: 'deploy@example.com', name: 'Deployer', passwordHash: 'x' })
      .returning();
    ownerId = owner!.id;
    const [org] = await client.db
      .insert(organization)
      .values({ name: 'Org', ownerId: owner!.id })
      .returning();
    const [proj] = await client.db
      .insert(project)
      .values({
        orgId: org!.id,
        name: 'app',
        repoUrl: 'https://github.com/example/app',
        defaultBranch: 'main',
        createdBy: owner!.id,
      })
      .returning();
    const [box] = await client.db
      .insert(server)
      .values({
        orgId: org!.id,
        name: 'box',
        host: '10.0.0.1',
        roles: ['build', 'app'],
        publicKey: 'ssh-ed25519 AAAA',
        privateKeyEnc: 'sealed',
        createdBy: owner!.id,
      })
      .returning();
    const [env] = await client.db
      .insert(projectEnvironment)
      .values({
        projectId: proj!.id,
        name: 'staging',
        serverId: box!.id,
        deployPath: '/srv/app',
        provisionStatus: 'provisioned',
      })
      .returning();
    environmentId = env!.id;
  });

  /**
   * An earlier deploy that reached `render`: it left a deployment row AND the
   * minted secrets on the environment, whatever it went on to do afterwards.
   */
  async function priorDeploy(status: 'failed' | 'healthy'): Promise<void> {
    await client.db.insert(deployment).values({
      environmentId,
      sha: 'oldsha',
      createdBy: ownerId,
      status,
      phase: 'up',
    });
    await client.db
      .update(projectEnvironment)
      .set({
        platformEnv: {
          IAM_JWT_SECRET: 'x'.repeat(48),
          IAM_COOKIE_SECRET: 'y'.repeat(48),
          APP_ENCRYPTION_KEY: 'z'.repeat(44),
          SEED_INITIAL_EMAIL: 'admin@example.com',
          SEED_INITIAL_PASSWORD: 'Sup3rSecret!x',
        },
      })
      .where(eq(projectEnvironment.id, environmentId));
  }

  /** Run one deploy and return the `.env` it rendered onto the app box. */
  async function deployAndCaptureEnv(): Promise<string> {
    const writes: Array<[string, string]> = [];
    const ssh = {
      exec: vi.fn(async (_t: unknown, op: string) =>
        op === 'resolve-head-sha' ? 'abc1234\n' : 'apps=api,web\n',
      ),
      writeFile: vi.fn(async (_t: unknown, path: string, content: string) => {
        writes.push([path, content]);
      }),
      pipeOp: vi.fn().mockResolvedValue(undefined),
    } as unknown as SshService;

    const [row] = await client.db
      .insert(deployment)
      .values({ environmentId, sha: '', createdBy: ownerId })
      .returning();

    await new DeploymentProcessor(
      client,
      ssh,
      secrets,
      disabledGithubApp,
      new FakeLogger().as<PinoLogger>(),
    ).process({ data: { deploymentId: row!.id } } as Job);

    const envFile = writes.find(([path]) => path.endsWith('/.env'));
    expect(envFile, 'the deploy never rendered a .env').toBeDefined();
    return envFile![1];
  }

  it('seeds on an environment that has never come up', async () => {
    expect(await deployAndCaptureEnv()).toContain('SEED_ON_STARTUP=true');
  });

  /**
   * The regression. A failed deploy still renders — and therefore still mints
   * IAM_JWT_SECRET — so the old gate treated the NEXT deploy as "not the first"
   * even though the app had never once started.
   */
  it('still seeds after an earlier deploy rendered and then FAILED', async () => {
    // The exact production state: the failed run got as far as `render`, so it
    // minted and PERSISTED the runtime secrets — then died before the app ever
    // started. platformEnv carrying IAM_JWT_SECRET is what made the old gate
    // call this "not the first deploy".
    await priorDeploy('failed');
    expect(await deployAndCaptureEnv()).toContain('SEED_ON_STARTUP=true');
  });

  it('stops seeding once the app has actually come up healthy', async () => {
    await priorDeploy('healthy');
    expect(await deployAndCaptureEnv()).not.toContain('SEED_ON_STARTUP');
  });
});
