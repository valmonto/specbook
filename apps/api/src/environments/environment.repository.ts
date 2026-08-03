import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  project,
  projectEnvironment,
  server,
  eq,
  and,
  asc,
  type NewProjectEnvironment,
  type Project,
  type ProjectEnvironment,
  type Server,
} from '@pkg/database';

/** An environment row joined with the display name of its server. */
export type EnvironmentWithServer = ProjectEnvironment & { serverName: string };

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
      .select({ env: projectEnvironment, serverName: server.name })
      .from(projectEnvironment)
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .where(eq(projectEnvironment.projectId, projectId))
      .orderBy(asc(projectEnvironment.name));
    return rows.map((r) => ({ ...r.env, serverName: r.serverName }));
  }

  async findById(id: string, projectId: string, orgId: string): Promise<EnvironmentWithServer | null> {
    const [row] = await this.dbClient.db
      .select({ env: projectEnvironment, serverName: server.name })
      .from(projectEnvironment)
      .innerJoin(project, and(eq(project.id, projectEnvironment.projectId), eq(project.orgId, orgId)))
      .innerJoin(server, eq(server.id, projectEnvironment.serverId))
      .where(and(eq(projectEnvironment.id, id), eq(projectEnvironment.projectId, projectId)))
      .limit(1);
    return row ? { ...row.env, serverName: row.serverName } : null;
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
}
