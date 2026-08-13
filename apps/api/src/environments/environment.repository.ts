import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  deployment,
  project,
  projectEnvironment,
  server,
  eq,
  and,
  asc,
  desc,
  type Deployment,
  type NewDeployment,
  type NewProjectEnvironment,
  type Project,
  type ProjectEnvironment,
  type Server,
} from '@pkg/database';

/** An environment row joined with the display identity of its server. */
export type EnvironmentWithServer = ProjectEnvironment & {
  serverName: string;
  serverHost: string;
};

/** Non-secret diagnosis projection of an environment + its server's connection identity. */
export interface EnvironmentDiagnostics {
  name: string;
  domain: string | null;
  deployPath: string | null;
  autoDeploy: boolean;
  provisionStatus: string;
  provisionError: string | null;
  provisionedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  serverName: string;
  serverHost: string;
  serverSshUser: string;
  serverPort: number;
}

/** Non-secret diagnosis projection of one deployment run (the `log` blob omitted). */
export interface DeploymentDiagnostics {
  id: string;
  environmentName: string;
  trigger: string;
  status: string;
  phase: string | null;
  sha: string;
  domain: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/**
 * Every read and write is org-scoped THROUGH the project join — an
 * environment is only reachable via a project the org owns.
 */
@Injectable()
export class EnvironmentRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  /** The org boundary for everything below: the project must belong to the org. */
  async findProject(projectId: string, orgId: string): Promise<Project | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.orgId, orgId)))
      .limit(1);
    return result ?? null;
  }

  /** Server lookup for eligibility checks — org-scoped like everything else. */
  async findServer(serverId: string, orgId: string): Promise<Server | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(server)
      .where(and(eq(server.id, serverId), eq(server.orgId, orgId)))
      .limit(1);
    return result ?? null;
  }

  async findForProject(projectId: string, orgId: string): Promise<EnvironmentWithServer[]> {
    const rows = await this.dbClient.db
      .select({ env: projectEnvironment, serverName: server.name, serverHost: server.host })
      .from(projectEnvironment)
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .where(eq(projectEnvironment.projectId, projectId))
      .orderBy(asc(projectEnvironment.name));
    return rows.map((r) => ({ ...r.env, serverName: r.serverName, serverHost: r.serverHost }));
  }

  async findById(id: string, projectId: string, orgId: string): Promise<EnvironmentWithServer | null> {
    const [row] = await this.dbClient.db
      .select({ env: projectEnvironment, serverName: server.name, serverHost: server.host })
      .from(projectEnvironment)
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .where(and(eq(projectEnvironment.id, id), eq(projectEnvironment.projectId, projectId)))
      .limit(1);
    return row ? { ...row.env, serverName: row.serverName, serverHost: row.serverHost } : null;
  }

  async create(data: NewProjectEnvironment): Promise<ProjectEnvironment> {
    const [result] = await this.dbClient.db.insert(projectEnvironment).values(data).returning();
    return result!;
  }

  /**
   * Update is guarded by a subquery-free two-step in the service (findById
   * first), so the write itself can key on id + projectId.
   */
  async update(
    id: string,
    projectId: string,
    data: Partial<NewProjectEnvironment>,
  ): Promise<ProjectEnvironment | null> {
    const [result] = await this.dbClient.db
      .update(projectEnvironment)
      .set(data)
      .where(and(eq(projectEnvironment.id, id), eq(projectEnvironment.projectId, projectId)))
      .returning();
    return result ?? null;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(projectEnvironment)
      .where(and(eq(projectEnvironment.id, id), eq(projectEnvironment.projectId, projectId)))
      .returning({ id: projectEnvironment.id });
    return result.length > 0;
  }

  // --- Deployments (reached only through org-scoped environment lookups) ---

  async createDeployment(data: NewDeployment): Promise<Deployment> {
    const [result] = await this.dbClient.db.insert(deployment).values(data).returning();
    return result!;
  }

  /** Newest first; feeds both the latest-deployment display and the breaker. */
  async recentDeployments(environmentId: string, limit = 10): Promise<Deployment[]> {
    return this.dbClient.db
      .select()
      .from(deployment)
      .where(eq(deployment.environmentId, environmentId))
      .orderBy(desc(deployment.createdAt))
      .limit(limit);
  }

  /**
   * Agent-court diagnosis read: a project's environments with the NON-SECRET
   * columns only, joined to the display+connection identity of their server.
   * The sealed columns (user_env_enc, private_key_enc, data_root_env_enc) and
   * the platform_env map are never selected, so nothing secret can leave here.
   * Org-scoped through the project join like every other read.
   */
  async findEnvironmentsForDiagnostics(
    projectId: string,
    orgId: string,
    name?: string,
  ): Promise<EnvironmentDiagnostics[]> {
    const conds = [eq(projectEnvironment.projectId, projectId)];
    if (name) conds.push(eq(projectEnvironment.name, name));
    return this.dbClient.db
      .select({
        name: projectEnvironment.name,
        domain: projectEnvironment.domain,
        deployPath: projectEnvironment.deployPath,
        autoDeploy: projectEnvironment.autoDeploy,
        provisionStatus: projectEnvironment.provisionStatus,
        provisionError: projectEnvironment.provisionError,
        provisionedAt: projectEnvironment.provisionedAt,
        createdAt: projectEnvironment.createdAt,
        updatedAt: projectEnvironment.updatedAt,
        serverName: server.name,
        serverHost: server.host,
        serverSshUser: server.sshUser,
        serverPort: server.port,
      })
      .from(projectEnvironment)
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .where(and(...conds))
      .orderBy(asc(projectEnvironment.name));
  }

  /**
   * Agent-court diagnosis read: recent deployment runs across ALL of a
   * project's environments, newest first, with the NON-SECRET columns only
   * (the scrubbed `log` blob is omitted). Org-scoped through the project join.
   */
  async recentDeploymentsForProject(
    projectId: string,
    orgId: string,
    limit = 20,
  ): Promise<DeploymentDiagnostics[]> {
    return this.dbClient.db
      .select({
        id: deployment.id,
        environmentName: projectEnvironment.name,
        trigger: deployment.trigger,
        status: deployment.status,
        phase: deployment.phase,
        sha: deployment.sha,
        domain: deployment.domain,
        error: deployment.error,
        startedAt: deployment.startedAt,
        finishedAt: deployment.finishedAt,
        createdAt: deployment.createdAt,
      })
      .from(deployment)
      .innerJoin(projectEnvironment, eq(projectEnvironment.id, deployment.environmentId))
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .where(eq(projectEnvironment.projectId, projectId))
      .orderBy(desc(deployment.createdAt))
      .limit(limit);
  }

  /**
   * Who on this server already claims the domain? One hostname routes to one
   * environment — without this, the most recent deploy would silently steal
   * it. Org-scoped through the project join like every other read.
   */
  async findDomainClaim(
    domain: string,
    serverId: string,
    orgId: string,
  ): Promise<ProjectEnvironment | null> {
    const [row] = await this.dbClient.db
      .select({ env: projectEnvironment })
      .from(projectEnvironment)
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .where(
        and(eq(projectEnvironment.domain, domain), eq(projectEnvironment.serverId, serverId)),
      )
      .limit(1);
    return row?.env ?? null;
  }

  /** Does the org own any build-capable server? (jsonb roles contain 'build') */
  async findBuildServer(orgId: string): Promise<Server | null> {
    const rows = await this.dbClient.db.select().from(server).where(eq(server.orgId, orgId));
    return (
      rows.find((s) => Array.isArray(s.roles) && (s.roles as string[]).includes('build')) ?? null
    );
  }
}
