import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  project,
  task,
  eq,
  and,
  count,
  desc,
  isNull,
  isNotNull,
  sql,
  type NewProject,
  type Project,
} from '@pkg/database';

/** Every read and write is org-scoped: a project never leaks across organizations. */
@Injectable()
export class ProjectRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  async create(data: NewProject): Promise<Project> {
    const [result] = await this.dbClient.db.insert(project).values(data).returning();
    return result!;
  }

  async findForOrg(
    orgId: string,
    opts: { skip: number; limit: number; archived?: boolean },
  ): Promise<{ data: Project[]; total: number }> {
    const whereClause = and(
      eq(project.orgId, orgId),
      opts.archived ? isNotNull(project.archivedAt) : isNull(project.archivedAt),
    );

    const [data, totalResult] = await Promise.all([
      this.dbClient.db
        .select()
        .from(project)
        .where(whereClause)
        .orderBy(desc(project.createdAt))
        .offset(opts.skip)
        .limit(opts.limit),
      this.dbClient.db.select({ count: count() }).from(project).where(whereClause),
    ]);

    return { data, total: totalResult[0]?.count ?? 0 };
  }

  /** projectId → status → count, one grouped query for the org's strip UI. */
  async countTasksByStatus(orgId: string): Promise<Map<string, Record<string, number>>> {
    const rows = await this.dbClient.db
      .select({ projectId: task.projectId, status: task.status, n: count() })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(eq(project.orgId, orgId))
      .groupBy(task.projectId, task.status);

    const byProject = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const counts = byProject.get(row.projectId) ?? {};
      counts[row.status] = Number(row.n);
      byProject.set(row.projectId, counts);
    }
    return byProject;
  }

  /**
   * This calendar month's summed agent-reported task cost per project —
   * the header's spend-vs-budget line. Bucketing matches the queue's budget
   * gate: a task counts in the month it last moved.
   */
  async monthSpendByProject(orgId: string): Promise<Map<string, number>> {
    const rows = await this.dbClient.db
      .select({
        projectId: task.projectId,
        spend: sql<number>`COALESCE(SUM(${task.costUsdCents}), 0)::int`,
      })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(
        and(
          eq(project.orgId, orgId),
          sql`COALESCE(${task.statusChangedAt}, ${task.createdAt}) >= date_trunc('month', now())`,
        ),
      )
      .groupBy(task.projectId);

    const byProject = new Map<string, number>();
    for (const row of rows) byProject.set(row.projectId, Number(row.spend));
    return byProject;
  }

  async findById(id: string, orgId: string): Promise<Project | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(project)
      .where(and(eq(project.id, id), eq(project.orgId, orgId)))
      .limit(1);

    return result ?? null;
  }

  async update(id: string, orgId: string, data: Partial<NewProject>): Promise<Project | null> {
    const [result] = await this.dbClient.db
      .update(project)
      .set(data)
      .where(and(eq(project.id, id), eq(project.orgId, orgId)))
      .returning();

    return result ?? null;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(project)
      .where(and(eq(project.id, id), eq(project.orgId, orgId)))
      .returning({ id: project.id });

    return result.length > 0;
  }
}
