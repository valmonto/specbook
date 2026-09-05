import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  deployment,
  project,
  projectEnvironment,
  server,
  user,
  dataAccessAudit,
  agent,
  eq,
  and,
  asc,
  desc,
  inArray,
  or,
  alias,
  type Deployment,
  type NewDeployment,
  type NewProjectEnvironment,
  type Project,
  type ProjectEnvironment,
  type Server,
  type DataAccessAuditRow,
  type NewDataAccessAuditRow,
} from '@pkg/database';

/** Aliased joins for the placement servers (each may be null = same as app server). */
const dbServer = alias(server, 'database_server');
const cacheServer = alias(server, 'cache_server');
const storageServer = alias(server, 'storage_server');
/** Who opened the current agent access window (display only). */
const grantUser = alias(user, 'grant_user');

const withServers = (row: {
  env: ProjectEnvironment;
  serverName: string;
  serverHost: string;
  databaseServerName: string | null;
  cacheServerName: string | null;
  storageServerName: string | null;
  mcpAccessByName: string | null;
}): EnvironmentWithServer => ({
  ...row.env,
  serverName: row.serverName,
  serverHost: row.serverHost,
  databaseServerName: row.databaseServerName,
  cacheServerName: row.cacheServerName,
  storageServerName: row.storageServerName,
  mcpAccessByName: row.mcpAccessByName,
});

/** An environment row joined with the display identity of its server. */
export type EnvironmentWithServer = ProjectEnvironment & {
  serverName: string;
  serverHost: string;
  /** Display names of the placement servers; null when the role stays on the app server. */
  databaseServerName: string | null;
  cacheServerName: string | null;
  storageServerName: string | null;
  /** Display name of whoever opened the agent access window; null when closed. */
  mcpAccessByName: string | null;
};

/** One environment using a server for some role — the shared-instance view. */
export interface HostedEnvironmentRow {
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  serverId: string;
  databaseServerId: string | null;
  cacheServerId: string | null;
  storageServerId: string | null;
  provisionStatus: string;
}

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
  mcpAccess: string;
  mcpAccessUntil: Date | null;
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
      .select({
        env: projectEnvironment,
        serverName: server.name,
        serverHost: server.host,
        databaseServerName: dbServer.name,
        cacheServerName: cacheServer.name,
        storageServerName: storageServer.name,
        mcpAccessByName: grantUser.name,
      })
      .from(projectEnvironment)
      .innerJoin(
        project,
        and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)),
      )
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .leftJoin(dbServer, eq(dbServer.id, projectEnvironment.databaseServerId))
      .leftJoin(cacheServer, eq(cacheServer.id, projectEnvironment.cacheServerId))
      .leftJoin(storageServer, eq(storageServer.id, projectEnvironment.storageServerId))
      .leftJoin(grantUser, eq(grantUser.id, projectEnvironment.mcpAccessBy))
      .where(eq(projectEnvironment.projectId, projectId))
      .orderBy(asc(projectEnvironment.name));
    return rows.map(withServers);
  }

  async findById(
    id: string,
    projectId: string,
    orgId: string,
  ): Promise<EnvironmentWithServer | null> {
    const [row] = await this.dbClient.db
      .select({
        env: projectEnvironment,
        serverName: server.name,
        serverHost: server.host,
        databaseServerName: dbServer.name,
        cacheServerName: cacheServer.name,
        storageServerName: storageServer.name,
        mcpAccessByName: grantUser.name,
      })
      .from(projectEnvironment)
      .innerJoin(
        project,
        and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)),
      )
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .leftJoin(dbServer, eq(dbServer.id, projectEnvironment.databaseServerId))
      .leftJoin(cacheServer, eq(cacheServer.id, projectEnvironment.cacheServerId))
      .leftJoin(storageServer, eq(storageServer.id, projectEnvironment.storageServerId))
      .leftJoin(grantUser, eq(grantUser.id, projectEnvironment.mcpAccessBy))
      .where(and(eq(projectEnvironment.id, id), eq(projectEnvironment.projectId, projectId)))
      .limit(1);
    return row ? withServers(row) : null;
  }

  /** Several org-scoped servers at once (placement validation loads them together). */
  async findServers(serverIds: string[], orgId: string): Promise<Server[]> {
    if (serverIds.length === 0) return [];
    return this.dbClient.db
      .select()
      .from(server)
      .where(and(inArray(server.id, serverIds), eq(server.orgId, orgId)));
  }

  /**
   * Every environment that uses `serverId` for ANY role — as its app server or
   * as the placement of its database, cache or storage. Org-scoped through
   * the project join; the caller derives which roles apply from the ids.
   */
  async findHostedBy(serverId: string, orgId: string): Promise<HostedEnvironmentRow[]> {
    return this.dbClient.db
      .select({
        environmentId: projectEnvironment.id,
        environmentName: projectEnvironment.name,
        projectId: project.id,
        projectName: project.name,
        serverId: projectEnvironment.serverId,
        databaseServerId: projectEnvironment.databaseServerId,
        cacheServerId: projectEnvironment.cacheServerId,
        storageServerId: projectEnvironment.storageServerId,
        provisionStatus: projectEnvironment.provisionStatus,
      })
      .from(projectEnvironment)
      .innerJoin(
        project,
        and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)),
      )
      .where(
        or(
          eq(projectEnvironment.serverId, serverId),
          eq(projectEnvironment.databaseServerId, serverId),
          eq(projectEnvironment.cacheServerId, serverId),
          eq(projectEnvironment.storageServerId, serverId),
        ),
      )
      .orderBy(asc(project.name), asc(projectEnvironment.name));
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
        mcpAccess: projectEnvironment.mcpAccess,
        mcpAccessUntil: projectEnvironment.mcpAccessUntil,
      })
      .from(projectEnvironment)
      .innerJoin(
        project,
        and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)),
      )
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
      .innerJoin(
        project,
        and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)),
      )
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
      .innerJoin(
        project,
        and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)),
      )
      .where(and(eq(projectEnvironment.domain, domain), eq(projectEnvironment.serverId, serverId)))
      .limit(1);
    return row?.env ?? null;
  }

  // --- Agent data-plane access audit (append-only) ---

  /** One audit line per executor call or grant/revoke. Never updated, never deleted. */
  async insertAudit(row: NewDataAccessAuditRow): Promise<DataAccessAuditRow> {
    const [result] = await this.dbClient.db.insert(dataAccessAudit).values(row).returning();
    return result!;
  }

  /**
   * The audit for one environment, newest first, org-scoped by the row's own
   * org_id (the environment link may already be NULL once it is deleted —
   * which is exactly when the audit still has to answer).
   */
  async findAuditForEnvironment(
    environmentId: string,
    orgId: string,
    limit = 50,
  ): Promise<DataAccessAuditRow[]> {
    return this.dbClient.db
      .select()
      .from(dataAccessAudit)
      .where(
        and(eq(dataAccessAudit.environmentId, environmentId), eq(dataAccessAudit.orgId, orgId)),
      )
      .orderBy(desc(dataAccessAudit.createdAt))
      .limit(limit);
  }

  /** Display name of a user, for audit rows written on a human's behalf. */
  async findUserName(userId: string): Promise<string | null> {
    const [row] = await this.dbClient.db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.name ?? null;
  }

  /** The task the calling key's agent currently holds, if its presence row says so. */
  async findClaimForKey(apiKeyId: string): Promise<string | null> {
    const [row] = await this.dbClient.db
      .select({ currentTaskId: agent.currentTaskId })
      .from(agent)
      .where(eq(agent.apiKeyId, apiKeyId))
      .limit(1);
    return row?.currentTaskId ?? null;
  }

  /** Does the org own any build-capable server? (jsonb roles contain 'build') */
  async findBuildServer(orgId: string): Promise<Server | null> {
    const rows = await this.dbClient.db.select().from(server).where(eq(server.orgId, orgId));
    return (
      rows.find((s) => Array.isArray(s.roles) && (s.roles as string[]).includes('build')) ?? null
    );
  }
}
