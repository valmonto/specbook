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
  appendDeployLog,
  dataPlaneUnitName,
  derivePublicPort,
  renderCaddySite,
  renderComposeFile,
  renderDeployEnv,
  renderProxyConf,
  resolveDeployDir,
  scrubDeployText,
  seedEnvDefaults,
  generateSeedPassword,
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

/** The deployment log's write side — see createLogSink. */
interface DeployLogSink {
  chunk: (text: string) => void;
  line: (text: string) => void;
  addLiteral: (value: string) => void;
  scrub: (text: string) => string;
  flush: () => Promise<void>;
}

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

    const sink = this.createLogSink(row.id);
    try {
      await this.run(row, sink);
    } catch (error) {
      // Tokens may ride inside the clone URL — scrub before recording.
      const detail = sink.scrub((error as Error).message ?? 'deploy failed');
      sink.line(`\nERROR: ${detail}`);
      await sink.flush();
      await this.finish(row.id, 'failed', detail.slice(0, 2000));
      this.logger.error({ deploymentId: row.id, err: detail.slice(0, 300) }, 'Deployment failed');
    }
  }

  /**
   * The deployment log's write side: every chunk is scrubbed on entry and
   * tail-capped, flushed to the row at most every couple of seconds so a
   * watcher sees a 20-minute build move while it runs. Known secret literals
   * (the clone URL) are registered as they come into existence.
   */
  private createLogSink(deploymentId: string): DeployLogSink {
    const literals: string[] = [];
    let buf = '';
    let timer: NodeJS.Timeout | null = null;
    const write = (): Promise<void> =>
      this.update(deploymentId, { log: buf }).catch(() => undefined);
    const chunk = (text: string): void => {
      buf = appendDeployLog(buf, scrubDeployText(text, literals));
      timer ??= setTimeout(() => {
        timer = null;
        void write();
      }, 2000);
    };
    return {
      chunk,
      line: (text: string): void => chunk(text.endsWith('\n') ? text : `${text}\n`),
      addLiteral: (value: string): void => {
        literals.push(value);
      },
      scrub: (text: string): string => scrubDeployText(text, literals),
      flush: async (): Promise<void> => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await write();
      },
    };
  }

  private async run(row: Deployment, sink: DeployLogSink): Promise<void> {
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
    sink.addLiteral(cloneUrl);
    const unit = dataPlaneUnitName(proj.name, env.name);
    const buildTarget = this.targetFor(buildServer);
    const appTarget = this.targetFor(appServer);

    // A domained environment needs the ingress plane, and the domain must
    // actually point at the app server — checked BEFORE the build so a DNS
    // mistake fails in seconds with a named cause, not after minutes.
    if (env.domain) {
      sink.line(`== preflight: ingress plane + dns for ${env.domain} ==`);
      await this.ssh.exec(appTarget, 'ensure-caddy', [], '', sink.chunk);
      await this.ssh.exec(appTarget, 'dns-points-at', [env.domain, appServer.host], '', sink.chunk);
    }

    await this.update(row.id, { status: 'building', startedAt: new Date(), phase: 'resolve' });
    sink.line(`== resolve: HEAD of ${proj.defaultBranch} ==`);
    const sha = (
      await this.ssh.exec(
        buildTarget,
        'resolve-head-sha',
        [proj.defaultBranch],
        cloneUrl + '\n',
        sink.chunk,
      )
    ).trim();
    await this.update(row.id, { sha, phase: 'build' });
    sink.line(`== build: images at ${sha.slice(0, 7)} on ${buildServer.name} ==`);
    const buildOut = await this.ssh.exec(
      buildTarget,
      'build-images',
      [unit, sha],
      cloneUrl + '\n',
      sink.chunk,
    );
    const apps = /apps=([a-z,]+)/.exec(buildOut)?.[1]?.split(',') ?? ['api', 'web'];

    // Transfer only when the images were built on a different box.
    if (buildServer.id !== appServer.id) {
      await this.update(row.id, { phase: 'transfer' });
      for (const app of apps) {
        sink.line(`== transfer: ${unit}-${app}:${sha.slice(0, 7)} → ${appServer.name} ==`);
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
    await this.update(row.id, { status: 'deploying', domain: env.domain ?? null, phase: 'render' });
    sink.line('== render: .env + compose + proxy ==');
    const publicPort = derivePublicPort(unit);
    const dir = resolveDeployDir(env.deployPath, unit);
    const userEnv = env.userEnvEnc
      ? (JSON.parse(this.secrets.open(env.userEnvEnc)) as Record<string, string>)
      : {};
    const { platformEnv, firstDeploy } = await this.ensureRuntimeSecrets(
      env,
      Object.keys(userEnv),
    );
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

    try {
      await this.ssh.exec(appTarget, 'ensure-dirs', [], dir + '\n', sink.chunk);
    } catch (error) {
      // The classic deployPath trap: a directory the SSH user cannot write.
      // Name the field instead of surfacing a bare mkdir stderr.
      if (/permission denied/i.test((error as Error).message ?? '')) {
        throw new Error(k.environments.errors.deployPathNotWritable, { cause: error });
      }
      throw error;
    }
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
    await this.update(row.id, { phase: 'up' });
    sink.line('== up: compose --wait + health gate ==');
    await this.ssh.exec(
      appTarget,
      'deploy-stack',
      [unit, dir, String(publicPort), ...(env.domain ? [env.domain] : [])],
      '',
      sink.chunk,
    );

    sink.line('deploy complete — healthy');
    await sink.flush();
    await this.finish(row.id, 'healthy', null);
    this.logger.info(
      { deploymentId: row.id, unit, sha, port: publicPort },
      'Deployment healthy',
    );
  }

  /**
   * IAM/session secrets are generated ONCE per environment and persisted
   * into platform_env so sessions survive redeploys; the marker also tells
   * us whether this is the first deploy (→ seed). First deploys also get
   * seed credentials generated unless the user layer already defines them —
   * the template refuses to boot in production without them.
   */
  private async ensureRuntimeSecrets(
    env: ProjectEnvironment,
    userEnvNames: readonly string[],
  ): Promise<{ platformEnv: Record<string, string>; firstDeploy: boolean }> {
    const platformEnv = { ...((env.platformEnv ?? {}) as Record<string, string>) };
    const firstDeploy = !platformEnv.IAM_JWT_SECRET;
    if (firstDeploy) {
      platformEnv.IAM_JWT_SECRET = generateSecret();
      platformEnv.IAM_COOKIE_SECRET = generateSecret();
      platformEnv.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      Object.assign(
        platformEnv,
        seedEnvDefaults({
          platformEnv,
          userEnvNames,
          domain: env.domain ?? null,
          // The seed login must satisfy the app's password policy (upper +
          // lower + digit + special); the alphanumeric generateSecret would
          // fail it. generateSecret still wires the URL-embedded secrets.
          generate: generateSeedPassword,
        }),
      );
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
