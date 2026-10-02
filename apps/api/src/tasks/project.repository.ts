import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  project,
  research,
  task,
  eq,
  and,
  count,
  max,
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

  /**
   * The per-project visibility layer, BELOW org scoping. `restrictMemberId`
   * present = a human MEMBER: the project must carry a `project_member` grant
   * for them (deny-by-default). Absent = OWNER/ADMIN or an agent — no
   * restriction, org scoping alone applies. The caller decides which via
   * isProjectScopedIdentity, so a machine identity is never blinded here.
   */
  private memberScope(restrictMemberId: string | undefined) {
    if (!restrictMemberId) return undefined;
    return sql`EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = ${project.id} AND pm.user_id = ${restrictMemberId}
    )`;
  }

  async create(data: NewProject): Promise<Project> {
    const [result] = await this.dbClient.db.insert(project).values(data).returning();
    return result!;
  }

  async findForOrg(
    orgId: string,
    opts: { skip: number; limit: number; archived?: boolean },
    restrictMemberId?: string,
  ): Promise<{ data: Project[]; total: number }> {
    const whereClause = and(
      eq(project.orgId, orgId),
      opts.archived ? isNotNull(project.archivedAt) : isNull(project.archivedAt),
      this.memberScope(restrictMemberId),
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
   * Research activity per project: how many documents sit at each status, and
   * when one was last touched.
   *
   * Sits next to the task counts because it answers the question the task
   * counts cannot: whether a project is still ASKING anything. A project can
   * show healthy task throughput for months while never opening a research
   * document — which is exactly what happened to one here, and nothing on the
   * board said so.
   */
  async researchActivityByProject(
    orgId: string,
  ): Promise<Map<string, { counts: Record<string, number>; lastActivityAt: Date | null }>> {
    const rows = await this.dbClient.db
      .select({
        projectId: research.projectId,
        status: research.status,
        n: count(),
        last: max(research.updatedAt),
      })
      .from(research)
      .where(eq(research.orgId, orgId))
      .groupBy(research.projectId, research.status);

    const byProject = new Map<
      string,
      { counts: Record<string, number>; lastActivityAt: Date | null }
    >();
    for (const row of rows) {
      // Org-level documents carry no project; they belong to no row here.
      if (!row.projectId) continue;
      const entry = byProject.get(row.projectId) ?? { counts: {}, lastActivityAt: null };
      entry.counts[row.status] = Number(row.n);
      // `max()` comes back as a timestamp STRING from the driver, not a Date.
      // Normalising here keeps the comparison below a date comparison rather
      // than a lexical one, and spares every caller the same coercion.
      const last = row.last ? new Date(row.last) : null;
      if (last && (!entry.lastActivityAt || last > entry.lastActivityAt)) {
        entry.lastActivityAt = last;
      }
      byProject.set(row.projectId, entry);
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

  async findById(id: string, orgId: string, restrictMemberId?: string): Promise<Project | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(project)
      .where(and(eq(project.id, id), eq(project.orgId, orgId), this.memberScope(restrictMemberId)))
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
