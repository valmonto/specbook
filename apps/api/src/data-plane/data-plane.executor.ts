import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { k } from '@pkg/locales';
import {
  MCP_DATA_PLANE_LIMITS,
  type ActiveUser,
  type DataAccessOutcome,
  type DataPlaneCacheOp,
  type DataPlaneResource,
  type DataPlaneStorageOp,
  type EnvironmentName,
} from '@pkg/contracts';
import type { NewDataAccessAuditRow, Server } from '@pkg/database';
import {
  createObjectReader,
  dataPlaneUnitName,
  InjectLogger,
  ObjectTooLargeError,
  PinoLogger,
  resolvePlacement,
  SecretsService,
  SshService,
  type SshTarget,
} from '@pkg/server';
import {
  EnvironmentRepository,
  type EnvironmentWithServer,
} from '../environments/environment.repository.js';
import { effectiveMcpAccess } from '../environments/mcp-access.js';
import { guardReadOnlySql } from './sql-guard.js';

/** The calling MCP key — the agent's identity for the audit. */
export interface DataPlaneCaller {
  keyId: string;
  name: string;
}

interface BaseRequest {
  projectId: string;
  environment: EnvironmentName;
  /** The task this read serves; falls back to the key's current claim. */
  taskId?: string;
}

export interface SqlRequest extends BaseRequest {
  resource: 'database';
  sql: string;
  limit?: number;
}

export interface CacheRequest extends BaseRequest {
  resource: 'cache';
  op: DataPlaneCacheOp;
  key?: string;
  pattern?: string;
  cursor?: string;
  count?: number;
}

export interface StorageRequest extends BaseRequest {
  resource: 'storage';
  op: DataPlaneStorageOp;
  key?: string;
  prefix?: string;
  limit?: number;
}

export type DataPlaneRequest = SqlRequest | CacheRequest | StorageRequest;

/** What an agent gets back: the data, or the remote's (scrubbed) error — never a credential. */
export type DataPlaneResult<T> =
  | { ok: true; environment: string; grantExpiresAt: string; data: T }
  | { ok: false; environment: string; grantExpiresAt: string; error: string };

const NIL = '__SB_NIL__';
const STORAGE_VARS = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

/**
 * The ONLY path from an agent to an environment's data plane. Policy lives
 * HERE, not in the MCP tools: every call — whatever tool made it — resolves
 * the environment inside the caller's org, checks the human-opened grant
 * against the clock, runs one bounded operation on the server that hosts the
 * role, scrubs every sealed value out of the output, and writes an audit row
 * whether it was allowed, denied or failed. A future tool cannot bypass any
 * of this, because there is nothing else to call.
 *
 * Production: the owner chose "allowed with a louder confirmation" over a
 * structural ban. That louder door is enforced where grants are OPENED
 * (EnvironmentService.grantMcpAccess); the executor treats a live grant on
 * production exactly like one on staging — the decision was already made,
 * loudly, by a human.
 */
@Injectable()
export class DataPlaneExecutor {
  constructor(
    private readonly environments: EnvironmentRepository,
    private readonly secrets: SecretsService,
    private readonly ssh: SshService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async execute(
    actor: ActiveUser,
    caller: DataPlaneCaller,
    request: DataPlaneRequest,
  ): Promise<DataPlaneResult<unknown>> {
    const started = Date.now();
    const project = await this.environments.findProject(request.projectId, actor.orgId);
    if (!project) throw new NotFoundException(k.tasks.errors.projectNotFound);
    const env = (await this.environments.findForProject(project.id, actor.orgId)).find(
      (e) => e.name === request.environment,
    );
    if (!env) throw new NotFoundException(k.environments.errors.notFound);

    const taskId = request.taskId ?? (await this.environments.findClaimForKey(caller.keyId));
    const { resource, operation, target } = describe(request);
    const audit = async (outcome: DataAccessOutcome, detail: string | null): Promise<void> => {
      await this.environments.insertAudit({
        orgId: actor.orgId,
        environmentId: env.id,
        projectName: project.name,
        environmentName: env.name,
        apiKeyId: caller.keyId,
        agentName: caller.name.slice(0, 64),
        taskId,
        resource,
        operation,
        target,
        outcome,
        detail,
        durationMs: Date.now() - started,
      } satisfies NewDataAccessAuditRow);
    };

    // THE grant check — server-side, against the clock, on every call. An
    // expired window and no window produce the same denial.
    const now = new Date();
    const grant = effectiveMcpAccess(env, now);
    if (grant.mode === 'none') {
      await audit('denied', k.environments.errors.mcpAccessDenied);
      this.logger.warn(
        { environmentId: env.id, keyId: caller.keyId, resource, operation },
        'Data-plane access denied: no live grant',
      );
      throw new ForbiddenException(k.environments.errors.mcpAccessDenied);
    }
    const grantExpiresAt = grant.until!.toISOString();

    if (env.provisionStatus !== 'provisioned' && request.resource !== 'storage') {
      await audit('failed', k.environments.errors.mcpAccessNotProvisioned);
      throw new BadRequestException(k.environments.errors.mcpAccessNotProvisioned);
    }

    const scrub = this.scrubber(env);
    try {
      const data = await this.run(actor.orgId, project.name, env, request);
      await audit('allowed', null);
      this.logger.info(
        { environmentId: env.id, keyId: caller.keyId, taskId, resource, operation },
        'Data-plane read',
      );
      return { ok: true, environment: env.name, grantExpiresAt, data: scrub(data) };
    } catch (error) {
      // Validation failures are the agent's to fix; they are audited as
      // 'failed' but surface as normal 4xx so the message reaches it.
      if (error instanceof BadRequestException) {
        await audit('failed', error.message);
        throw error;
      }
      const message = scrub(String((error as Error).message ?? error)) as string;
      await audit('failed', message.slice(0, 1000));
      this.logger.warn(
        { environmentId: env.id, keyId: caller.keyId, resource, operation, error: message },
        'Data-plane read failed',
      );
      return { ok: false, environment: env.name, grantExpiresAt, error: message.slice(0, 2000) };
    }
  }

  private async run(
    orgId: string,
    projectName: string,
    env: EnvironmentWithServer,
    request: DataPlaneRequest,
  ): Promise<unknown> {
    switch (request.resource) {
      case 'database':
        return this.readSql(orgId, projectName, env, request);
      case 'cache':
        return this.readCache(orgId, projectName, env, request);
      case 'storage':
        return this.readStorage(env, request);
    }
  }

  /** One bounded SELECT, on the server that hosts the database role, as the unit's own role. */
  private async readSql(
    orgId: string,
    projectName: string,
    env: EnvironmentWithServer,
    request: SqlRequest,
  ): Promise<unknown> {
    const guarded = guardReadOnlySql(request.sql);
    if (!guarded.ok) throw new BadRequestException(k.environments.errors.mcpAccessInvalidSql);
    const cap = Math.min(
      Math.max(1, request.limit ?? MCP_DATA_PLANE_LIMITS.sqlDefaultRows),
      MCP_DATA_PLANE_LIMITS.sqlRowCap,
    );
    const unit = dataPlaneUnitName(projectName, env.name);
    const target = await this.targetFor(orgId, env, 'database');
    const out = await this.ssh.exec(
      target,
      'data-plane-read-sql',
      [unit, String(cap), String(MCP_DATA_PLANE_LIMITS.sqlStatementTimeoutMs)],
      `${guarded.statement}\n`,
    );
    const rows = JSON.parse(out.trim() || '[]') as unknown[];
    return { rows, rowCount: rows.length, capped: rows.length >= cap, cap };
  }

  /** GET/EXISTS/TYPE/TTL on a key, or one SCAN page — on the server hosting the cache role. */
  private async readCache(
    orgId: string,
    projectName: string,
    env: EnvironmentWithServer,
    request: CacheRequest,
  ): Promise<unknown> {
    const subject = request.op === 'scan' ? (request.pattern ?? '*') : request.key;
    if (!subject) throw new BadRequestException(k.environments.errors.mcpAccessKeyRequired);
    const count = Math.min(
      Math.max(1, request.count ?? 100),
      MCP_DATA_PLANE_LIMITS.cacheScanMaxCount,
    );
    const cursor = /^\d{1,20}$/.test(request.cursor ?? '') ? request.cursor! : '0';
    const unit = dataPlaneUnitName(projectName, env.name);
    const target = await this.targetFor(orgId, env, 'cache');
    const platform = (env.platformEnv ?? {}) as Record<string, string>;
    // The co-located Redis has no auth (empty line); a placed one has requirepass.
    const password = platform.REDIS_PASSWORD ?? '';
    const out = await this.ssh.exec(
      target,
      'data-plane-read-redis',
      [unit, request.op, subject, cursor, String(count)],
      `${password}\n`,
    );
    const text = out.replace(/\r?\n$/, '');
    switch (request.op) {
      case 'get': {
        if (text === NIL) return { key: subject, exists: false, value: null };
        const capped = text.length > MCP_DATA_PLANE_LIMITS.cacheValueMaxBytes;
        return {
          key: subject,
          exists: true,
          value: capped ? text.slice(0, MCP_DATA_PLANE_LIMITS.cacheValueMaxBytes) : text,
          truncated: capped,
        };
      }
      case 'exists':
        return { key: subject, exists: text.trim() === '1' };
      case 'type':
        return { key: subject, type: text.trim() };
      case 'ttl':
        return { key: subject, ttlSeconds: Number.parseInt(text.trim(), 10) };
      case 'scan': {
        const [nextCursor = '0', ...keys] = text.split('\n');
        return {
          pattern: subject,
          cursor: nextCursor.trim(),
          done: nextCursor.trim() === '0',
          keys: keys.filter(Boolean),
        };
      }
    }
  }

  /**
   * Object storage: read through the environment's OWN S3_* variables (sealed
   * user env), opened server-side for this call only and never returned.
   * There is no platform-provisioned bucket per environment yet, so an
   * environment without those vars has nothing to read.
   */
  private async readStorage(env: EnvironmentWithServer, request: StorageRequest): Promise<unknown> {
    const vars = this.openUserEnv(env.userEnvEnc);
    if (STORAGE_VARS.some((name) => !vars[name])) {
      throw new BadRequestException(k.environments.errors.mcpAccessStorageNotConfigured);
    }
    const reader = createObjectReader({
      endpoint: vars.S3_ENDPOINT!,
      bucket: vars.S3_BUCKET!,
      accessKeyId: vars.S3_ACCESS_KEY_ID!,
      secretAccessKey: vars.S3_SECRET_ACCESS_KEY!,
      region: vars.S3_REGION,
    });
    switch (request.op) {
      case 'list': {
        const max = Math.min(
          Math.max(1, request.limit ?? 100),
          MCP_DATA_PLANE_LIMITS.storageListMaxKeys,
        );
        return reader.list(request.prefix ?? '', max);
      }
      case 'head':
        if (!request.key) throw new BadRequestException(k.environments.errors.mcpAccessKeyRequired);
        return reader.head(request.key);
      case 'get': {
        if (!request.key) throw new BadRequestException(k.environments.errors.mcpAccessKeyRequired);
        try {
          return await reader.get(request.key, MCP_DATA_PLANE_LIMITS.storageObjectMaxBytes);
        } catch (error) {
          if (error instanceof ObjectTooLargeError) {
            throw new BadRequestException(k.environments.errors.mcpAccessObjectTooLarge);
          }
          throw error;
        }
      }
    }
  }

  /** The SSH target of the server hosting `role` for this environment (placement-aware). */
  private async targetFor(
    orgId: string,
    env: EnvironmentWithServer,
    role: Exclude<DataPlaneResource, 'storage'>,
  ): Promise<SshTarget> {
    const ids = [env.serverId, env.databaseServerId, env.cacheServerId, env.storageServerId].filter(
      (id): id is string => !!id,
    );
    const servers = await this.environments.findServers([...new Set(ids)], orgId);
    const placement = resolvePlacement(
      env,
      servers.map((s) => ({ id: s.id, name: s.name, host: s.host, roles: rolesOf(s) })),
    );
    const chosen = placement[role].server;
    const srv = servers.find((s) => s.id === chosen.id)!;
    return {
      host: srv.host,
      port: srv.port,
      user: srv.sshUser,
      privateKey: this.secrets.open(srv.privateKeyEnc),
      hostFingerprint: srv.hostFingerprint,
    };
  }

  private openUserEnv(sealed: string | null): Record<string, string> {
    if (!sealed) return {};
    return JSON.parse(this.secrets.open(sealed)) as Record<string, string>;
  }

  /**
   * Belt and braces for "sealed values never leave": every string in a result
   * is checked against the environment's own secret material — user env
   * values, the unit's database password, the cache password — and any
   * occurrence is redacted. The executors never return credentials by
   * construction; this catches a row that happens to CONTAIN one.
   */
  private scrubber(env: EnvironmentWithServer): (value: unknown) => unknown {
    const platform = (env.platformEnv ?? {}) as Record<string, string>;
    const secrets = new Set<string>();
    for (const value of Object.values(this.openUserEnv(env.userEnvEnc))) {
      if (value.length >= 6) secrets.add(value);
    }
    const dbPassword = /^postgresql:\/\/[^:]+:([^@]+)@/.exec(platform.DATABASE_URL ?? '')?.[1];
    if (dbPassword) secrets.add(dbPassword);
    if (platform.REDIS_PASSWORD) secrets.add(platform.REDIS_PASSWORD);
    const redact = (text: string): string => {
      let out = text;
      for (const secret of secrets) out = out.split(secret).join('[redacted]');
      return out;
    };
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return redact(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, walk(v)]),
        );
      }
      return value;
    };
    return walk;
  }
}

/** Audit vocabulary for one request: resource, operation, and what it addressed. */
function describe(request: DataPlaneRequest): {
  resource: DataPlaneResource;
  operation: string;
  target: string;
} {
  switch (request.resource) {
    case 'database':
      return { resource: 'database', operation: 'sql', target: request.sql.slice(0, 4000) };
    case 'cache':
      return {
        resource: 'cache',
        operation: request.op,
        target: (request.op === 'scan' ? (request.pattern ?? '*') : (request.key ?? '')).slice(
          0,
          1000,
        ),
      };
    case 'storage':
      return {
        resource: 'storage',
        operation: request.op,
        target: (request.op === 'list' ? (request.prefix ?? '') : (request.key ?? '')).slice(
          0,
          1000,
        ),
      };
  }
}

const rolesOf = (srv: Server): string[] =>
  Array.isArray(srv.roles) ? (srv.roles as string[]) : [];
