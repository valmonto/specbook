import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { ActiveUser } from '@pkg/contracts';
import { SecretsService, type SshService } from '@pkg/server';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataPlaneExecutor } from '@/data-plane/data-plane.executor.js';
import type { EnvironmentRepository } from '@/environments/environment.repository.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ENV = '33333333-3333-4333-8333-333333333333';
const APP = '44444444-4444-4444-8444-444444444444';
const PG = '55555555-5555-4555-8555-555555555555';
const TASK = '66666666-6666-4666-8666-666666666666';
const actor: ActiveUser = {
  userId: 'u',
  orgId: ORG,
  orgRole: 'MEMBER',
  systemRole: 'USER',
  isAgent: true,
};
const caller = { keyId: 'key-1', name: 'runner-a' };

/**
 * Policy lives in the executor, not in the tools: whatever calls it, a call
 * without a live human-opened grant is denied AND audited; a call with one
 * runs exactly one bounded remote op on the server that hosts the role, and
 * nothing sealed survives into the result.
 */
describe('DataPlaneExecutor — the only path to the data plane', () => {
  let secrets: SecretsService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let ssh: { exec: ReturnType<typeof vi.fn> };
  let executor: DataPlaneExecutor;
  let audit: Record<string, unknown>[];
  let env: Record<string, unknown>;

  const USER_SECRET = 'user-secret-value-ABCDEF';
  const DB_PASSWORD = 'dbpassw0rdXYZ';
  const REDIS_PASSWORD = 'redispasswordQWE';
  const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsealedkeymaterial\n-----END';

  const server = (id: string, name: string, roles: string[]) => ({
    id,
    orgId: ORG,
    name,
    host: `${name}.internal`,
    port: 22,
    sshUser: 'deploy',
    roles,
    privateKeyEnc: secrets.seal(PRIVATE_KEY),
    hostFingerprint: 'SHA256:pinned',
  });

  beforeEach(() => {
    secrets = new SecretsService({
      get: () => randomBytes(32).toString('base64'),
    } as unknown as ConfigService);
    audit = [];
    env = {
      id: ENV,
      projectId: PROJECT,
      name: 'staging',
      serverId: APP,
      databaseServerId: null,
      cacheServerId: null,
      storageServerId: null,
      dataTransport: null,
      provisionStatus: 'provisioned',
      platformEnv: {
        DATABASE_URL: `postgresql://the_project_staging:${DB_PASSWORD}@specbook-postgres:5432/the_project_staging`,
        REDIS_HOST: 'specbook-redis-the_project_staging',
        REDIS_PORT: '6379',
      },
      userEnvEnc: secrets.seal(JSON.stringify({ API_TOKEN: USER_SECRET })),
      mcpAccess: 'read',
      mcpAccessUntil: new Date(Date.now() + 10 * 60_000),
      mcpAccessBy: 'owner',
      mcpAccessReason: null,
    };
    repo = {
      findProject: vi.fn().mockResolvedValue({ id: PROJECT, orgId: ORG, name: 'The Project' }),
      findForProject: vi.fn().mockImplementation(async () => [env]),
      findServers: vi
        .fn()
        .mockImplementation(async (ids: string[]) =>
          [server(APP, 'app-box', ['app', 'data']), server(PG, 'pg-box', ['database'])].filter(
            (s) => ids.includes(s.id),
          ),
        ),
      findClaimForKey: vi.fn().mockResolvedValue(TASK),
      insertAudit: vi.fn().mockImplementation(async (row: Record<string, unknown>) => {
        audit.push(row);
        return { id: 'a', ...row };
      }),
    };
    ssh = { exec: vi.fn().mockResolvedValue('[]\n') };
    executor = new DataPlaneExecutor(
      repo as unknown as EnvironmentRepository,
      secrets,
      ssh as unknown as SshService,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  const sql = (statement = 'SELECT 1', extra: Record<string, unknown> = {}) =>
    executor.execute(actor, caller, {
      resource: 'database',
      projectId: PROJECT,
      environment: 'staging',
      sql: statement,
      ...extra,
    });

  describe('the grant check — server-side, on every call, against the clock', () => {
    it('denies and audits when no window was ever opened (mcpAccess none)', async () => {
      env.mcpAccess = 'none';
      env.mcpAccessUntil = null;
      await expect(sql()).rejects.toThrow('environments.errors.mcpAccessDenied');
      expect(ssh.exec).not.toHaveBeenCalled();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        orgId: ORG,
        environmentId: ENV,
        projectName: 'The Project',
        environmentName: 'staging',
        apiKeyId: 'key-1',
        agentName: 'runner-a',
        taskId: TASK,
        resource: 'database',
        operation: 'sql',
        target: 'SELECT 1',
        outcome: 'denied',
        detail: 'environments.errors.mcpAccessDenied',
      });
    });

    it('an EXPIRED window is the same denial — nothing the agent sends can revive it', async () => {
      env.mcpAccessUntil = new Date(Date.now() - 1000);
      await expect(sql()).rejects.toThrow('environments.errors.mcpAccessDenied');
      expect(ssh.exec).not.toHaveBeenCalled();
      expect(audit[0]).toMatchObject({ outcome: 'denied' });
    });

    it('a "new tool" calling the executor gets the same denial — policy is not in the tool', async () => {
      env.mcpAccess = 'none';
      // Any request shape, any resource: the executor is the gate.
      await expect(
        executor.execute(actor, caller, {
          resource: 'cache',
          projectId: PROJECT,
          environment: 'staging',
          op: 'get',
          key: 'sess:1',
        }),
      ).rejects.toThrow('environments.errors.mcpAccessDenied');
      await expect(
        executor.execute(actor, caller, {
          resource: 'storage',
          projectId: PROJECT,
          environment: 'staging',
          op: 'list',
        }),
      ).rejects.toThrow('environments.errors.mcpAccessDenied');
      expect(audit.map((a) => a.outcome)).toEqual(['denied', 'denied']);
    });

    it("a 'write' window also satisfies a read", async () => {
      env.mcpAccess = 'write';
      const result = await sql();
      expect(result.ok).toBe(true);
    });

    it('a foreign org reads the project as absent — nothing is audited under someone else', async () => {
      repo.findProject!.mockResolvedValue(null);
      await expect(sql()).rejects.toThrow('tasks.errors.projectNotFound');
      expect(audit).toHaveLength(0);
    });
  });

  describe('database reads', () => {
    it('runs ONE bounded read op on the app server (legacy placement) as the unit, and audits allowed', async () => {
      ssh.exec.mockResolvedValue('[{"id":1,"email":"a@x.io"}]\n');
      const result = await sql('SELECT id, email FROM "user"', { limit: 10, taskId: TASK });
      expect(ssh.exec).toHaveBeenCalledTimes(1);
      const [target, op, args, stdin] = ssh.exec.mock.calls[0]!;
      expect(target).toMatchObject({
        host: 'app-box.internal',
        user: 'deploy',
        privateKey: PRIVATE_KEY,
      });
      expect(op).toBe('data-plane-read-sql');
      expect(args).toEqual(['the_project_staging', '10', '5000']);
      expect(stdin).toBe('SELECT id, email FROM "user"\n');
      expect(result).toMatchObject({
        ok: true,
        environment: 'staging',
        data: { rows: [{ id: 1, email: 'a@x.io' }], rowCount: 1, capped: false, cap: 10 },
      });
      expect(audit[0]).toMatchObject({ outcome: 'allowed', resource: 'database', taskId: TASK });
      expect(typeof audit[0]!.durationMs).toBe('number');
    });

    it('a MOVED database role is read on the database server, not the app server', async () => {
      env.databaseServerId = PG;
      env.dataTransport = 'private-network';
      await sql();
      expect(ssh.exec.mock.calls[0]![0]).toMatchObject({ host: 'pg-box.internal' });
    });

    it('the row cap is clamped to the hard limit', async () => {
      await sql('SELECT 1', { limit: 99_999 });
      expect(ssh.exec.mock.calls[0]![2]).toEqual(['the_project_staging', '200', '5000']);
    });

    it('refuses non-read SQL before anything reaches the wire, audited as failed', async () => {
      await expect(sql('DELETE FROM task')).rejects.toThrow(
        'environments.errors.mcpAccessInvalidSql',
      );
      expect(ssh.exec).not.toHaveBeenCalled();
      expect(audit[0]).toMatchObject({ outcome: 'failed', target: 'DELETE FROM task' });
    });

    it('refuses an unprovisioned environment (nothing to read yet)', async () => {
      env.provisionStatus = 'unprovisioned';
      await expect(sql()).rejects.toThrow('environments.errors.mcpAccessNotProvisioned');
      expect(audit[0]).toMatchObject({ outcome: 'failed' });
    });

    it('a remote failure comes back as ok:false with the error, audited as failed — not a 500', async () => {
      ssh.exec.mockRejectedValue(
        new Error('remote-op data-plane-read-sql exited 3: relation "nope" does not exist'),
      );
      const result = await sql('SELECT * FROM nope');
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain('relation "nope" does not exist');
      expect(audit[0]).toMatchObject({ outcome: 'failed' });
    });
  });

  describe('sealed values never leave', () => {
    it('redacts the unit password, cache password and user env values wherever they appear', async () => {
      env.platformEnv = { ...(env.platformEnv as object), REDIS_PASSWORD: REDIS_PASSWORD };
      ssh.exec.mockResolvedValue(
        JSON.stringify([
          {
            note: `token is ${USER_SECRET}`,
            url: `postgresql://u:${DB_PASSWORD}@h/db`,
            cache: REDIS_PASSWORD,
          },
        ]),
      );
      const result = await sql();
      const text = JSON.stringify(result);
      expect(text).not.toContain(USER_SECRET);
      expect(text).not.toContain(DB_PASSWORD);
      expect(text).not.toContain(REDIS_PASSWORD);
      expect(text).not.toContain(PRIVATE_KEY.slice(0, 20));
      expect(text).toContain('[redacted]');
    });

    it('a remote error mentioning a secret is scrubbed before it reaches the agent or the audit', async () => {
      ssh.exec.mockRejectedValue(new Error(`FATAL: password "${DB_PASSWORD}" rejected`));
      const result = await sql();
      expect(JSON.stringify(result)).not.toContain(DB_PASSWORD);
      expect(String(audit[0]!.detail)).not.toContain(DB_PASSWORD);
    });

    it('the result never carries platform_env, user env or credentials as fields', async () => {
      const result = await sql();
      const keys = JSON.stringify(result);
      for (const forbidden of ['DATABASE_URL', 'userEnvEnc', 'privateKey', 'API_TOKEN']) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  describe('cache reads', () => {
    const cache = (
      op: 'get' | 'exists' | 'type' | 'ttl' | 'scan',
      extra: Record<string, unknown>,
    ) =>
      executor.execute(actor, caller, {
        resource: 'cache',
        projectId: PROJECT,
        environment: 'staging',
        op,
        ...extra,
      });

    it('GET on a present key hands the password over stdin, never argv', async () => {
      env.platformEnv = { ...(env.platformEnv as object), REDIS_PASSWORD: REDIS_PASSWORD };
      ssh.exec.mockResolvedValue('hello\n');
      const result = await cache('get', { key: 'greeting' });
      const [, op, args, stdin] = ssh.exec.mock.calls[0]!;
      expect(op).toBe('data-plane-read-redis');
      expect(args).toEqual(['the_project_staging', 'get', 'greeting', '0', '100']);
      expect(stdin).toBe(`${REDIS_PASSWORD}\n`);
      expect(result).toMatchObject({
        ok: true,
        data: { key: 'greeting', exists: true, value: 'hello' },
      });
    });

    it('GET on a missing key reads as exists:false / value:null', async () => {
      ssh.exec.mockResolvedValue('__SB_NIL__\n');
      const result = await cache('get', { key: 'missing' });
      expect(result).toMatchObject({ ok: true, data: { exists: false, value: null } });
    });

    it('SCAN returns one page: cursor, done flag and keys', async () => {
      ssh.exec.mockResolvedValue('17\nsess:1\nsess:2\n');
      const result = await cache('scan', { pattern: 'sess:*', count: 50 });
      expect(ssh.exec.mock.calls[0]![2]).toEqual([
        'the_project_staging',
        'scan',
        'sess:*',
        '0',
        '50',
      ]);
      expect(result).toMatchObject({
        ok: true,
        data: { pattern: 'sess:*', cursor: '17', done: false, keys: ['sess:1', 'sess:2'] },
      });
    });

    it('a key is required for the single-key ops', async () => {
      await expect(cache('ttl', {})).rejects.toThrow('environments.errors.mcpAccessKeyRequired');
      expect(audit[0]).toMatchObject({ outcome: 'failed', operation: 'ttl' });
    });
  });

  describe('storage reads', () => {
    it('refuses when the environment has no S3_* variables — there is nothing to read with', async () => {
      await expect(
        executor.execute(actor, caller, {
          resource: 'storage',
          projectId: PROJECT,
          environment: 'staging',
          op: 'list',
        }),
      ).rejects.toThrow('environments.errors.mcpAccessStorageNotConfigured');
      expect(audit[0]).toMatchObject({ outcome: 'failed', resource: 'storage', operation: 'list' });
    });
  });
});
