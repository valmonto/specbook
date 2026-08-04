import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  project,
  projectEnvironment,
  server,
  eq,
  type Server,
} from '@pkg/database';
import {
  dataPlaneUnitName,
  InjectLogger,
  PinoLogger,
  SecretsService,
  SshService,
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
 * per-environment password is reused from platform_env when present, so a
 * re-provision of a healthy environment rotates nothing.
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
      await this.deprovision(job.data.deprovision.serverId, job.data.deprovision.unit);
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
      const [srv] = await this.dbClient.db
        .select()
        .from(server)
        .where(eq(server.id, env.serverId))
        .limit(1);
      const [proj] = await this.dbClient.db
        .select()
        .from(project)
        .where(eq(project.id, env.projectId))
        .limit(1);
      if (!srv || !proj) throw new Error(k.environments.errors.notFound);

      const roles = Array.isArray(srv.roles) ? (srv.roles as string[]) : [];
      if (!roles.includes('data')) {
        await this.fail(environmentId, k.environments.errors.serverNotData);
        return;
      }

      const target = this.targetFor(srv);
      const unit = dataPlaneUnitName(proj.name, env.name);

      // Root credentials: generated exactly once per server, then sealed.
      const rootPassword = await this.ensureRootPassword(srv);
      await this.ssh.exec(target, 'data-plane-ensure', [], rootPassword + '\n');

      // Per-env password: reuse the one already wired into platform_env so a
      // re-provision never rotates a working credential.
      const platformEnv = (env.platformEnv ?? {}) as Record<string, string>;
      const unitPassword = this.passwordFromUrl(platformEnv.DATABASE_URL, unit) ?? generatePassword();
      await this.ssh.exec(target, 'data-plane-provision-unit', [unit], unitPassword + '\n');

      // The wiring the deploy slice renders: container-DNS on the
      // specbook-data network — nothing is published on host ports.
      const wired: Record<string, string> = {
        ...platformEnv,
        DATABASE_URL: `postgresql://${unit}:${unitPassword}@specbook-postgres:5432/${unit}`,
        REDIS_HOST: `specbook-redis-${unit}`,
        REDIS_PORT: '6379',
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
      this.logger.info({ environmentId, unit, serverId: srv.id }, 'Environment provisioned');
    } catch (error) {
      await this.fail(environmentId, (error as Error).message?.slice(0, 500) ?? 'provision failed');
      this.logger.error({ environmentId, err: error }, 'Environment provisioning failed');
    }
  }

  private async deprovision(serverId: string, unit: string): Promise<void> {
    const [srv] = await this.dbClient.db
      .select()
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    if (!srv) return; // server gone — nothing left to clean
    try {
      await this.ssh.exec(this.targetFor(srv), 'data-plane-deprovision-unit', [unit]);
      this.logger.info({ serverId, unit }, 'Environment unit deprovisioned');
    } catch (error) {
      // Best-effort by contract: a dead box must never block deletion.
      this.logger.warn({ serverId, unit, err: (error as Error).message }, 'Deprovision failed');
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
      .set({ dataRootEnvEnc: this.secrets.seal(JSON.stringify({ POSTGRES_ROOT_PASSWORD: password })) })
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
