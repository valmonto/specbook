import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  deployment,
  organization,
  project,
  projectEnvironment,
  server,
  eq,
  type Deployment,
  type ProjectEnvironment,
  type Server,
} from '@pkg/database';
import {
  dataPlaneUnitName,
  derivePublicPort,
  renderCaddySite,
  renderComposeFile,
  renderDeployEnv,
  renderProxyConf,
  DEPLOYMENT_QUEUE,
  GithubAppService,
  InjectLogger,
  PinoLogger,
  SecretsService,
  SshService,
  type DeploymentJobPayload,
  type SshTarget,
} from '@pkg/server';
import { k } from '@pkg/locales';

const generateSecret = (): string => randomBytes(24).toString('base64url').replace(/[-_]/g, 'x');

/**
 * The whole build-and-deploy chain, in one serialized job:
 * resolve sha → build images on a build server → (transfer if the app server
 * differs) → render env+compose+proxy onto the app server → compose up with
 * a health gate. Statuses land on the deployment row as each phase starts.
 * The rendered .env is the ONLY place user-secret values ever materialize,
 * and it exists solely on the target box (0600).
 */
@Processor(DEPLOYMENT_QUEUE.name, DEPLOYMENT_QUEUE.workerOptions)
export class DeploymentProcessor extends WorkerHost {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
    private readonly ssh: SshService,
    private readonly secrets: SecretsService,
    private readonly github: GithubAppService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<DeploymentJobPayload>): Promise<void> {
    const [row] = await this.dbClient.db
      .select()
      .from(deployment)
      .where(eq(deployment.id, job.data.deploymentId))
      .limit(1);
    if (!row || row.status === 'healthy') return; // gone or already done

    let cloneUrl = '';
    try {
      await this.run(row, (url) => (cloneUrl = url));
    } catch (error) {
      // Tokens may ride inside the clone URL — scrub before recording.
      let detail = (error as Error).message ?? 'deploy failed';
      if (cloneUrl) detail = detail.replaceAll(cloneUrl, '<repo-url>');
      detail = detail.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      await this.finish(row.id, 'failed', detail.slice(0, 2000));
      this.logger.error({ deploymentId: row.id, err: detail.slice(0, 300) }, 'Deployment failed');
    }
  }

  private async run(row: Deployment, onCloneUrl: (url: string) => void): Promise<void> {
    const [env] = await this.dbClient.db
      .select()
      .from(projectEnvironment)
      .where(eq(projectEnvironment.id, row.environmentId))
      .limit(1);
    if (!env) throw new Error(k.environments.errors.notFound);
    const [proj] = await this.dbClient.db
      .select()
      .from(project)
      .where(eq(project.id, env.projectId))
      .limit(1);
    const [appServer] = await this.dbClient.db
      .select()
      .from(server)
      .where(eq(server.id, env.serverId))
      .limit(1);
    if (!proj || !appServer) throw new Error(k.environments.errors.notFound);
    if (env.provisionStatus !== 'provisioned') {
      throw new Error(k.environments.errors.notProvisioned);
    }

    // Build happens on a build-role server of the same org; the app server
    // itself is the normal single-box case.
    const buildServer = await this.pickBuildServer(proj.orgId, appServer);
    if (!buildServer) throw new Error(k.environments.errors.noBuildServer);

    const cloneUrl = await this.cloneUrlFor(proj);
    onCloneUrl(cloneUrl);
    const unit = dataPlaneUnitName(proj.name, env.name);
    const buildTarget = this.targetFor(buildServer);
    const appTarget = this.targetFor(appServer);

    // A domained environment needs the ingress plane, and the domain must
    // actually point at the app server — checked BEFORE the build so a DNS
    // mistake fails in seconds with a named cause, not after minutes.
    if (env.domain) {
      await this.ssh.exec(appTarget, 'ensure-caddy');
      await this.ssh.exec(appTarget, 'dns-points-at', [env.domain, appServer.host]);
    }

    await this.update(row.id, { status: 'building', startedAt: new Date() });
    const sha = (
      await this.ssh.exec(buildTarget, 'resolve-head-sha', [proj.defaultBranch], cloneUrl + '\n')
    ).trim();
    await this.update(row.id, { sha });
    const buildOut = await this.ssh.exec(
      buildTarget,
      'build-images',
      [unit, sha],
      cloneUrl + '\n',
    );
    const apps = /apps=([a-z,]+)/.exec(buildOut)?.[1]?.split(',') ?? ['api', 'web'];

    // Transfer only when the images were built on a different box.
    if (buildServer.id !== appServer.id) {
      for (const app of apps) {
        await this.ssh.pipeOp(
          buildTarget,
          'image-export',
          [`${unit}-${app}:${sha}`],
          appTarget,
          'image-import',
        );
      }
    }

    // Snapshot the domain onto the run: it records what this deploy serves,
    // which is how the UI tells a live domain from a pending edit.
    await this.update(row.id, { status: 'deploying', domain: env.domain ?? null });
    const publicPort = derivePublicPort(unit);
    const dir = env.deployPath?.replace(/\/+$/, '') || `apps/${unit}`;
    const { platformEnv, firstDeploy } = await this.ensureRuntimeSecrets(env);
    const userEnv = env.userEnvEnc
      ? (JSON.parse(this.secrets.open(env.userEnvEnc)) as Record<string, string>)
      : {};
    const envFile = renderDeployEnv([
      platformEnv,
      userEnv,
      {
        NODE_ENV: 'production',
        WORKER_PORT: '3001',
        IAM_REDIS_HOST: platformEnv.REDIS_HOST ?? 'localhost',
        PUBLIC_PORT: String(publicPort),
        ...(firstDeploy ? { SEED_ON_STARTUP: 'true' } : {}),
      },
    ]);

    await this.ssh.exec(appTarget, 'ensure-dirs', [], dir + '\n');
    await this.ssh.writeFile(appTarget, `${dir}/.env`, envFile);
    await this.ssh.writeFile(
      appTarget,
      `${dir}/compose.yml`,
      renderComposeFile({ unit, sha, publicPort, apps, domain: env.domain }),
    );
    await this.ssh.writeFile(appTarget, `${dir}/nginx.conf`, renderProxyConf());
    if (env.domain) {
      await this.ssh.writeFile(
        appTarget,
        `specbook-caddy/sites/${unit}.caddy`,
        renderCaddySite(unit, env.domain),
      );
    }
    await this.ssh.exec(appTarget, 'deploy-stack', [
      unit,
      dir,
      String(publicPort),
      ...(env.domain ? [env.domain] : []),
    ]);

    await this.finish(row.id, 'healthy', null);
    this.logger.info(
      { deploymentId: row.id, unit, sha, port: publicPort },
      'Deployment healthy',
    );
  }

  /**
   * IAM/session secrets are generated ONCE per environment and persisted
   * into platform_env so sessions survive redeploys; the marker also tells
   * us whether this is the first deploy (→ seed).
   */
  private async ensureRuntimeSecrets(
    env: ProjectEnvironment,
  ): Promise<{ platformEnv: Record<string, string>; firstDeploy: boolean }> {
    const platformEnv = { ...((env.platformEnv ?? {}) as Record<string, string>) };
    const firstDeploy = !platformEnv.IAM_JWT_SECRET;
    if (firstDeploy) {
      platformEnv.IAM_JWT_SECRET = generateSecret();
      platformEnv.IAM_COOKIE_SECRET = generateSecret();
      platformEnv.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      await this.dbClient.db
        .update(projectEnvironment)
        .set({ platformEnv })
        .where(eq(projectEnvironment.id, env.id));
    }
    return { platformEnv, firstDeploy };
  }

  /** App-token clone URL when the org is connected; plain URL otherwise (public repos). */
  private async cloneUrlFor(proj: {
    orgId: string;
    githubRepoFullName: string | null;
    repoUrl: string | null;
  }): Promise<string> {
    if (this.github.enabled && proj.githubRepoFullName) {
      const [org] = await this.dbClient.db
        .select({ installationId: organization.githubInstallationId })
        .from(organization)
        .where(eq(organization.id, proj.orgId))
        .limit(1);
      if (org?.installationId) {
        const minted = await this.github.mintRepoToken(org.installationId, proj.githubRepoFullName);
        if (minted) {
          return `https://x-access-token:${minted.token}@github.com/${proj.githubRepoFullName}.git`;
        }
      }
    }
    if (proj.repoUrl) return proj.repoUrl;
    throw new Error(k.tasks.errors.projectNotBound);
  }

  private async pickBuildServer(orgId: string, appServer: Server): Promise<Server | null> {
    const roles = (s: Server): string[] => (Array.isArray(s.roles) ? (s.roles as string[]) : []);
    if (roles(appServer).includes('build')) return appServer;
    const rows = await this.dbClient.db.select().from(server).where(eq(server.orgId, orgId));
    return rows.find((s) => roles(s).includes('build')) ?? null;
  }

  private async update(id: string, patch: Partial<Deployment>): Promise<void> {
    await this.dbClient.db.update(deployment).set(patch).where(eq(deployment.id, id));
  }

  private async finish(id: string, status: 'healthy' | 'failed', error: string | null) {
    await this.update(id, { status, error, finishedAt: new Date() });
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
