import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  inArray,
  project,
  projectEnvironment,
  server,
  eq,
  type Server,
} from '@pkg/database';
import {
  dataPlaneUnitName,
  deriveCachePort,
  renderPlatformWiring,
  resolveDeployDir,
  resolvePlacement,
  serverSatisfies,
  InjectLogger,
  PinoLogger,
  SecretsService,
  SshService,
  type ResolvedPlacement,
  type SshTarget,
  ENVIRONMENT_PROVISION_QUEUE,
  type EnvironmentProvisionJobPayload,
} from '@pkg/server';
import { k } from '@pkg/locales';

/** URL-safe, shell-safe, SQL-safe: strictly alphanumeric. */
const generatePassword = (): string => randomBytes(24).toString('base64url').replace(/[-_]/g, 'x');

/**
 * Data-plane provisioning: the only place staging infrastructure is ever
 * created. Idempotent end to end — the remote ops CREATE-or-ALTER, and the
 * per-environment passwords are reused from platform_env when present, so a
 * re-provision of a healthy environment rotates nothing.
 *
 * Placement: each role is provisioned on the server `resolvePlacement` names.
 * With NULL placement that is the app server under its combined `data` role,
 * through exactly the ops and wiring this processor always used. A MOVED role
 * runs its own op on its own server (published on that server's registered
 * address, never 0.0.0.0) and only that role's wiring changes.
 */
@Processor(ENVIRONMENT_PROVISION_QUEUE.name, ENVIRONMENT_PROVISION_QUEUE.workerOptions)
export class EnvironmentProvisionProcessor extends WorkerHost {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
    private readonly ssh: SshService,
    private readonly secrets: SecretsService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<EnvironmentProvisionJobPayload>): Promise<void> {
    if (job.data.environmentId) {
      await this.provision(job.data.environmentId);
      return;
    }
    if (job.data.deprovision) {
      await this.deprovision(job.data.deprovision);
    }
  }

  private async provision(environmentId: string): Promise<void> {
    const [env] = await this.dbClient.db
      .select()
      .from(projectEnvironment)
      .where(eq(projectEnvironment.id, environmentId))
      .limit(1);
    if (!env) return; // deleted while queued — nothing to do

    try {
      const serverIds = [
        env.serverId,
        env.databaseServerId,
        env.cacheServerId,
        env.storageServerId,
      ].filter((id): id is string => !!id);
      const [servers, [proj]] = await Promise.all([
        this.dbClient.db.select().from(server).where(inArray(server.id, serverIds)),
        this.dbClient.db.select().from(project).where(eq(project.id, env.projectId)).limit(1),
      ]);
      const byId = new Map(servers.map((s) => [s.id, s]));
      if (!byId.has(env.serverId) || !proj) throw new Error(k.environments.errors.notFound);

      const placement = resolvePlacement(
        env,
        servers.map((s) => ({ id: s.id, name: s.name, host: s.host, roles: rolesOf(s) })),
      );

      // Eligibility, re-checked here because the API's check is fast feedback
      // and the rows may have changed while the job was queued.
      if (!serverSatisfies(placement.database.server, 'database', placement.database.remote)) {
        await this.fail(
          environmentId,
          placement.database.remote
            ? k.environments.errors.serverNotDatabase
            : k.environments.errors.serverNotData,
        );
        return;
      }
      if (!serverSatisfies(placement.cache.server, 'cache', placement.cache.remote)) {
        await this.fail(
          environmentId,
          placement.cache.remote
            ? k.environments.errors.serverNotCache
            : k.environments.errors.serverNotData,
        );
        return;
      }
      if (placement.storage.remote) {
        // Buckets and access keys are a follow-up; the API refuses this earlier.
        await this.fail(environmentId, k.environments.errors.storageProvisionUnsupported);
        return;
      }
      if (placement.anyRemote && placement.transport !== 'private-network') {
        // `tls` is accepted by the schema but nothing installs certificates yet.
        await this.fail(
          environmentId,
          placement.transport === 'tls'
            ? k.environments.errors.transportTlsUnsupported
            : k.environments.errors.transportRequired,
        );
        return;
      }

      const unit = dataPlaneUnitName(proj.name, env.name);
      const platformEnv = (env.platformEnv ?? {}) as Record<string, string>;
      const appServer = byId.get(placement.app.id)!;
      const dbServer = byId.get(placement.database.server.id)!;
      const cacheServer = byId.get(placement.cache.server.id)!;

      // Per-env passwords: reuse the ones already wired into platform_env so a
      // re-provision never rotates a working credential.
      const databasePassword =
        this.passwordFromUrl(platformEnv.DATABASE_URL, unit) ?? generatePassword();
      const cachePassword = platformEnv.REDIS_PASSWORD ?? generatePassword();

      // --- database ---
      const dbRootPassword = await this.ensureRootPassword(dbServer);
      if (placement.database.remote) {
        await this.ssh.exec(
          this.targetFor(dbServer),
          'data-plane-ensure-published',
          [dbServer.host],
          dbRootPassword + '\n',
        );
        await this.ssh.exec(
          this.targetFor(dbServer),
          'database-provision-unit',
          [unit],
          databasePassword + '\n',
        );
      } else {
        // The legacy path, verbatim: ensure + provision-unit on the app server.
        await this.ssh.exec(
          this.targetFor(appServer),
          'data-plane-ensure',
          [],
          dbRootPassword + '\n',
        );
      }

      // --- cache ---
      if (placement.cache.remote) {
        await this.ssh.exec(
          this.targetFor(cacheServer),
          'cache-provision-unit',
          [unit, cacheServer.host, String(deriveCachePort(unit))],
          cachePassword + '\n',
        );
      }
      if (!placement.database.remote) {
        // data-plane-provision-unit does BOTH the role/database and the
        // co-located Redis — unchanged for the legacy path. When only the
        // cache moved, the Postgres half still happens here and the Redis
        // half it also creates is simply unused by the rendered wiring.
        await this.ssh.exec(
          this.targetFor(appServer),
          'data-plane-provision-unit',
          [unit],
          databasePassword + '\n',
        );
      } else if (!placement.cache.remote) {
        // Database moved away, cache stayed: the app server still needs the
        // network and the co-located Redis. provision-unit would also create
        // an unused Postgres role here, so ensure the network + Redis alone.
        await this.ssh.exec(this.targetFor(appServer), 'app-network-ensure', []);
        await this.ssh.exec(
          this.targetFor(appServer),
          'cache-provision-unit',
          [unit, '127.0.0.1', String(deriveCachePort(unit))],
          cachePassword + '\n',
        );
      } else {
        await this.ssh.exec(this.targetFor(appServer), 'app-network-ensure', []);
      }

      // Make the deploy directory exist and be writable by the SSH user NOW,
      // so the first deploy's render phase never hits deployPathNotWritable.
      const deployDir = resolveDeployDir(env.deployPath, unit);
      await this.ssh.exec(this.targetFor(appServer), 'ensure-deploy-path', [
        deployDir,
        appServer.sshUser,
      ]);

      const wired: Record<string, string> = {
        ...platformEnv,
        ...this.wiring(unit, placement, databasePassword, cachePassword),
      };
      await this.dbClient.db
        .update(projectEnvironment)
        .set({
          platformEnv: wired,
          provisionStatus: 'provisioned',
          provisionError: null,
          provisionedAt: new Date(),
        })
        .where(eq(projectEnvironment.id, environmentId));
      this.logger.info(
        {
          environmentId,
          unit,
          appServerId: appServer.id,
          databaseServerId: placement.database.remote ? dbServer.id : null,
          cacheServerId: placement.cache.remote ? cacheServer.id : null,
        },
        'Environment provisioned',
      );
    } catch (error) {
      await this.fail(environmentId, (error as Error).message?.slice(0, 500) ?? 'provision failed');
      this.logger.error({ environmentId, err: error }, 'Environment provisioning failed');
    }
  }

  /**
   * The rendered wiring. A database that moved away but a cache that stayed
   * is the one shape `renderPlatformWiring` alone cannot express: the
   * co-located Redis is then the password-protected cache-provision-unit
   * container on the app box, reached over container DNS.
   */
  private wiring(
    unit: string,
    placement: ResolvedPlacement,
    databasePassword: string,
    cachePassword: string,
  ): Record<string, string> {
    const wired = renderPlatformWiring({ unit, placement, databasePassword, cachePassword });
    if (placement.database.remote && !placement.cache.remote) {
      wired.REDIS_PASSWORD = cachePassword;
    }
    return wired;
  }

  private async deprovision(
    snapshot: NonNullable<EnvironmentProvisionJobPayload['deprovision']>,
  ): Promise<void> {
    const { serverId, unit, databaseServerId, cacheServerId } = snapshot;
    // App server: the compose stack, the vhost, and — for a NULL placement —
    // the whole co-located data plane (the original op, unchanged).
    await this.bestEffort(serverId, 'data-plane-deprovision-unit', [unit], { unit });
    if (databaseServerId && databaseServerId !== serverId) {
      await this.bestEffort(databaseServerId, 'database-deprovision-unit', [unit], { unit });
    }
    if (cacheServerId && cacheServerId !== serverId) {
      await this.bestEffort(cacheServerId, 'cache-deprovision-unit', [unit], { unit });
    }
  }

  private async bestEffort(
    serverId: string,
    op: 'data-plane-deprovision-unit' | 'database-deprovision-unit' | 'cache-deprovision-unit',
    args: string[],
    ctx: Record<string, string>,
  ): Promise<void> {
    const [srv] = await this.dbClient.db
      .select()
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    if (!srv) return; // server gone — nothing left to clean
    try {
      await this.ssh.exec(this.targetFor(srv), op, args);
      this.logger.info({ serverId, op, ...ctx }, 'Environment unit deprovisioned');
    } catch (error) {
      // Best-effort by contract: a dead box must never block deletion.
      this.logger.warn(
        { serverId, op, ...ctx, err: (error as Error).message },
        'Deprovision failed',
      );
    }
  }

  /**
   * A failed run records WHY but never destroys previously working wiring:
   * platform_env is left untouched.
   */
  private async fail(environmentId: string, detail: string): Promise<void> {
    await this.dbClient.db
      .update(projectEnvironment)
      .set({ provisionStatus: 'failed', provisionError: detail })
      .where(eq(projectEnvironment.id, environmentId));
  }

  /** Root credentials for the shared Postgres on THIS server: generated once, then sealed. */
  private async ensureRootPassword(srv: Server): Promise<string> {
    if (srv.dataRootEnvEnc) {
      const parsed = JSON.parse(this.secrets.open(srv.dataRootEnvEnc)) as {
        POSTGRES_ROOT_PASSWORD: string;
      };
      return parsed.POSTGRES_ROOT_PASSWORD;
    }
    const password = generatePassword();
    await this.dbClient.db
      .update(server)
      .set({
        dataRootEnvEnc: this.secrets.seal(JSON.stringify({ POSTGRES_ROOT_PASSWORD: password })),
      })
      .where(eq(server.id, srv.id));
    return password;
  }

  private passwordFromUrl(url: string | undefined, unit: string): string | null {
    if (!url) return null;
    const match = new RegExp(`^postgresql://${unit}:([A-Za-z0-9]+)@`).exec(url);
    return match?.[1] ?? null;
  }

  private targetFor(srv: Server): SshTarget {
    return {
      host: srv.host,
      port: srv.port,
      user: srv.sshUser,
      privateKey: this.secrets.open(srv.privateKeyEnc),
      hostFingerprint: srv.hostFingerprint,
    };
  }
}

const rolesOf = (srv: Server): string[] =>
  Array.isArray(srv.roles) ? (srv.roles as string[]) : [];
