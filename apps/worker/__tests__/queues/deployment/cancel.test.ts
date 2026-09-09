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

/** App disabled, so the clone URL falls back to the project's repoUrl. */
const disabledGithubApp = { enabled: false } as unknown as GithubAppService;
const secrets = { open: () => 'PRIVATE-KEY' } as unknown as SecretsService;

/**
 * Cancel has to act on the command that is RUNNING, not at the next phase
 * boundary. A build is minutes long and is the phase a human actually presses
 * Cancel during, so a signal that never reaches it makes the button a no-op
 * for as long as the build lasts. That is what shipped: `signal` is an
 * optional trailing parameter on ssh.exec, and build-images omitted it.
 */
describeIntegration('DeploymentProcessor — cancel reaches the running command', () => {
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
  let deploymentId: string;

  // The worker suites share one test database and run serialized, so rows left
  // behind here break a sibling suite's truncate on a RESTRICT foreign key.
  afterAll(async () => {
    await truncate(client.db, tables);
  });

  beforeEach(async () => {
    await truncate(client.db, tables);
    const [owner] = await client.db
      .insert(user)
      .values({ email: 'deploy@example.com', name: 'Deployer', passwordHash: 'x' })
      .returning();
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
    // One box holding both roles: the transfer phase is irrelevant here, and
    // skipping it keeps the test about the build.
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
    const [row] = await client.db
      .insert(deployment)
      .values({ environmentId: env!.id, sha: '', createdBy: owner!.id })
      .returning();
    deploymentId = row!.id;
  });

  function processorWith(ssh: SshService): DeploymentProcessor {
    return new DeploymentProcessor(
      client,
      ssh,
      secrets,
      disabledGithubApp,
      new FakeLogger().as<PinoLogger>(),
    );
  }

  it('aborts a build in flight when a human presses Cancel', async () => {
    let buildSignal: AbortSignal | undefined;
    const ssh = {
      exec: vi.fn(
        async (
          _t: unknown,
          op: string,
          _a: string[],
          _s: string,
          _o: unknown,
          signal?: AbortSignal,
        ) => {
          if (op !== 'build-images') return 'abc1234\n';
          // A real build blocks for minutes. This resolves only on abort — if
          // the signal never arrives the test times out, which is the honest
          // failure for "Cancel did nothing".
          buildSignal = signal;
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      ),
    } as unknown as SshService;

    const running = processorWith(ssh).process({ data: { deploymentId } } as Job);

    await vi.waitFor(() => expect(buildSignal).toBeDefined());
    await client.db
      .update(deployment)
      .set({ cancelRequested: true })
      .where(eq(deployment.id, deploymentId));

    await running;

    const [row] = await client.db
      .select()
      .from(deployment)
      .where(eq(deployment.id, deploymentId))
      .limit(1);
    expect(row?.status).toBe('cancelled');
  }, 30_000);

  /** Every remote call in a run must carry it, not only the one that was fixed. */
  it('passes an abort signal to every remote command it issues', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const ssh = {
      exec: vi.fn(
        async (
          _t: unknown,
          op: string,
          _a: string[],
          _s: string,
          _o: unknown,
          signal?: AbortSignal,
        ) => {
          signals.push(signal);
          return op === 'resolve-head-sha' ? 'abc1234\n' : 'apps=api,web\n';
        },
      ),
      writeFile: vi.fn().mockResolvedValue(undefined),
      pipeOp: vi.fn().mockResolvedValue(undefined),
    } as unknown as SshService;

    await processorWith(ssh).process({ data: { deploymentId } } as Job);

    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  }, 30_000);
});
