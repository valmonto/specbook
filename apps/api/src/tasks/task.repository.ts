import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  organizationUser,
  project,
  task,
  taskComment,
  taskDependency,
  eq,
  and,
  count,
  desc,
  asc,
  sql,
  inArray,
  isNull,
  type NewTask,
  type NewTaskComment,
  type Task,
  type TaskComment,
} from '@pkg/database';
import { MERGE_DEBT_CAP, type TaskStatus } from '@pkg/contracts';

export interface ListTasksFilter {
  skip: number;
  limit: number;
  projectId?: string;
  status?: TaskStatus;
  available?: boolean;
}

export interface DependencyInfoRow {
  id: string;
  title: string;
  status: string;
}

/**
 * Tasks carry no orgId of their own — every query is scoped through the
 * owning project (`orgGuard`), so a task id from another organization
 * behaves exactly like a missing one.
 */
@Injectable()
export class TaskRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  /** Membership subquery usable in UPDATE/DELETE, where joins are unavailable. */
  private orgGuard(orgId: string) {
    return sql`${task.projectId} IN (SELECT id FROM project WHERE org_id = ${orgId})`;
  }

  /**
   * The agent queue predicate: no dependency still in a non-terminal status.
   * Terminal (done/cancelled) unblocks — a cancelled prerequisite should not
   * strand its dependents forever; removing the edge is the human's call.
   */
  private noUnfinishedDependencies() {
    return sql`NOT EXISTS (
      SELECT 1 FROM task_dependency d
      JOIN task dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = ${task.id} AND dep.status NOT IN ('done', 'cancelled')
    )`;
  }

  /**
   * Per-project throttles on the agent queue:
   * - `max_parallel`: at N in_progress tasks the project stops serving ready
   *   ones (auto modes default this to 1 in the UI — serialized claims are
   *   what make branch-CI ≈ post-merge-CI overnight).
   * - a tripped circuit breaker (red default branch, auto modes) stops the
   *   queue entirely: building on a red main is waste.
   */
  private underProjectThrottles() {
    return sql`NOT EXISTS (
      SELECT 1 FROM project p
      WHERE p.id = ${task.projectId}
        AND (
          (p.max_parallel IS NOT NULL AND (
            SELECT COUNT(*) FROM task t3
            WHERE t3.project_id = p.id AND t3.status = 'in_progress'
          ) >= p.max_parallel)
          OR (p.mode <> 'manual' AND p.auto_paused_at IS NOT NULL)
        )
    )`;
  }

  /**
   * The merge-debt gate: a project sitting on MERGE_DEBT_CAP approved
   * (merged-pending) tasks stops feeding the agent queue until the queue
   * drains. Enforced here, in the one query every runner uses, so no client
   * can bypass it.
   */
  private underMergeDebtCap() {
    return sql`${task.projectId} NOT IN (
      SELECT project_id FROM task WHERE status = 'approved'
      GROUP BY project_id HAVING COUNT(*) >= ${MERGE_DEBT_CAP}
    )`;
  }

  /**
   * The budget gate: a project whose monthly spend (summed agent-reported
   * task cost, bucketed by when the task last moved) has reached its budget
   * stops feeding the agent queue — the runaway-loop stop, enforced in the
   * same query as the other caps so no client can bypass it.
   */
  private underBudgetCap() {
    return sql`${task.projectId} NOT IN (
      SELECT p.id FROM project p
      WHERE p.budget_usd_cents IS NOT NULL
        AND (
          SELECT COALESCE(SUM(t2.cost_usd_cents), 0) FROM task t2
          WHERE t2.project_id = p.id
            AND COALESCE(t2.status_changed_at, t2.created_at) >= date_trunc('month', now())
        ) >= p.budget_usd_cents
    )`;
  }

  /**
   * Additive cost accumulation — increments, never overwrites. A field the
   * agent did not report stays untouched (and stays null if never reported):
   * an agent that only knows tokens must not zero the USD column.
   */
  async addCost(
    id: string,
    orgId: string,
    delta: { tokensIn?: number; tokensOut?: number; usdCents?: number },
  ): Promise<Task | null> {
    const patch: Record<string, unknown> = {};
    if (delta.tokensIn !== undefined) {
      patch.costTokensIn = sql`COALESCE(${task.costTokensIn}, 0) + ${delta.tokensIn}`;
    }
    if (delta.tokensOut !== undefined) {
      patch.costTokensOut = sql`COALESCE(${task.costTokensOut}, 0) + ${delta.tokensOut}`;
    }
    if (delta.usdCents !== undefined) {
      patch.costUsdCents = sql`COALESCE(${task.costUsdCents}, 0) + ${delta.usdCents}`;
    }
    const [result] = await this.dbClient.db
      .update(task)
      .set(patch)
      .where(and(eq(task.id, id), this.orgGuard(orgId)))
      .returning();
    return result ?? null;
  }

  async create(data: NewTask): Promise<Task> {
    const [result] = await this.dbClient.db.insert(task).values(data).returning();
    return result!;
  }

  async findForOrg(
    orgId: string,
    filter: ListTasksFilter,
  ): Promise<{ data: Task[]; total: number }> {
    const conditions = [eq(project.orgId, orgId)];
    if (filter.projectId) conditions.push(eq(task.projectId, filter.projectId));
    if (filter.status) conditions.push(eq(task.status, filter.status));
    if (filter.available) {
      conditions.push(eq(task.status, 'ready'));
      // Human-only tasks never feed agents — enforced here so no client
      // (MCP or HTTP) can claim one into the claim-then-blocked dance.
      conditions.push(eq(task.isHumanTask, false));
      // Archived projects feed no agents; their tasks stay visible in plain
      // lists (history) but leave the dispatch queue entirely.
      conditions.push(isNull(project.archivedAt));
      conditions.push(this.noUnfinishedDependencies());
      conditions.push(this.underMergeDebtCap());
      conditions.push(this.underProjectThrottles());
      conditions.push(this.underBudgetCap());
    }
    const whereClause = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.dbClient.db
        .select()
        .from(task)
        .innerJoin(project, eq(task.projectId, project.id))
        .where(whereClause)
        .orderBy(desc(task.priority), asc(task.createdAt))
        .offset(filter.skip)
        .limit(filter.limit),
      this.dbClient.db
        .select({ count: count() })
        .from(task)
        .innerJoin(project, eq(task.projectId, project.id))
        .where(whereClause),
    ]);

    return { data: rows.map((r) => r.task), total: totalResult[0]?.count ?? 0 };
  }

  async findById(id: string, orgId: string): Promise<Task | null> {
    const [row] = await this.dbClient.db
      .select()
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(and(eq(task.id, id), eq(project.orgId, orgId)))
      .limit(1);

    return row?.task ?? null;
  }

  async update(id: string, orgId: string, data: Partial<NewTask>): Promise<Task | null> {
    const [result] = await this.dbClient.db
      .update(task)
      .set(data)
      .where(and(eq(task.id, id), this.orgGuard(orgId)))
      .returning();

    return result ?? null;
  }

  /**
   * Compare-and-swap on status: the WHERE clause pins the status the caller
   * validated against, so two racing transitions cannot both win — the loser
   * updates zero rows. This is also what makes claiming atomic.
   */
  async casUpdateStatus(
    id: string,
    orgId: string,
    fromStatus: TaskStatus,
    data: Partial<NewTask>,
  ): Promise<Task | null> {
    const [result] = await this.dbClient.db
      .update(task)
      .set(data)
      .where(and(eq(task.id, id), eq(task.status, fromStatus), this.orgGuard(orgId)))
      .returning();

    return result ?? null;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(task)
      .where(and(eq(task.id, id), this.orgGuard(orgId)))
      .returning({ id: task.id });

    return result.length > 0;
  }

  // --- Comments ---

  async createComment(data: NewTaskComment): Promise<TaskComment> {
    const [result] = await this.dbClient.db.insert(taskComment).values(data).returning();
    return result!;
  }

  async findComments(taskId: string): Promise<TaskComment[]> {
    return this.dbClient.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, taskId))
      .orderBy(asc(taskComment.createdAt));
  }

  /**
   * Atomically stamp every unacked note as seen and return them (ordered).
   * Returning IS acking — there is no way to read a note without the stamp,
   * which is what lets the review gate trust acked_at. Org-scoped like every
   * tenant write: a foreign task id acks (and leaks) nothing.
   */
  async ackNotes(taskId: string, orgId: string): Promise<TaskComment[]> {
    const rows = await this.dbClient.db
      .update(taskComment)
      .set({ ackedAt: new Date() })
      .where(
        and(
          eq(taskComment.taskId, taskId),
          eq(taskComment.kind, 'note'),
          isNull(taskComment.ackedAt),
          sql`${taskComment.taskId} IN (
            SELECT t.id FROM task t
            JOIN project p ON p.id = t.project_id
            WHERE p.org_id = ${orgId}
          )`,
        ),
      )
      .returning();
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** The needs_review gate's question: is a steering note still unread? */
  async hasUnackedNotes(taskId: string): Promise<boolean> {
    const [row] = await this.dbClient.db
      .select({ n: count() })
      .from(taskComment)
      .where(
        and(
          eq(taskComment.taskId, taskId),
          eq(taskComment.kind, 'note'),
          isNull(taskComment.ackedAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  }

  // --- Dependencies ---

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.dbClient.db
      .insert(taskDependency)
      .values({ taskId, dependsOnTaskId })
      .onConflictDoNothing();
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(taskDependency)
      .where(
        and(eq(taskDependency.taskId, taskId), eq(taskDependency.dependsOnTaskId, dependsOnTaskId)),
      )
      .returning({ taskId: taskDependency.taskId });

    return result.length > 0;
  }

  async findDependencyInfo(taskId: string): Promise<DependencyInfoRow[]> {
    const edges = await this.dbClient.db
      .select()
      .from(taskDependency)
      .where(eq(taskDependency.taskId, taskId));
    return this.taskInfoByIds(edges.map((e) => e.dependsOnTaskId));
  }

  async findDependentInfo(taskId: string): Promise<DependencyInfoRow[]> {
    const edges = await this.dbClient.db
      .select()
      .from(taskDependency)
      .where(eq(taskDependency.dependsOnTaskId, taskId));
    return this.taskInfoByIds(edges.map((e) => e.taskId));
  }

  private async taskInfoByIds(ids: string[]): Promise<DependencyInfoRow[]> {
    if (ids.length === 0) return [];
    return this.dbClient.db
      .select({ id: task.id, title: task.title, status: task.status })
      .from(task)
      .where(inArray(task.id, ids));
  }

  /** Member ids of an org — recipients for court-transition notifications. */
  async findOrgMemberIds(orgId: string): Promise<string[]> {
    const rows = await this.dbClient.db
      .select({ userId: organizationUser.userId })
      .from(organizationUser)
      .where(eq(organizationUser.orgId, orgId));
    return rows.map((r) => r.userId);
  }

  /** All edges within one project — small enough to walk in memory for cycle checks. */
  async findProjectDependencyEdges(
    projectId: string,
  ): Promise<Array<{ taskId: string; dependsOnTaskId: string }>> {
    return this.dbClient.db
      .select({
        taskId: taskDependency.taskId,
        dependsOnTaskId: taskDependency.dependsOnTaskId,
      })
      .from(taskDependency)
      .innerJoin(task, eq(taskDependency.taskId, task.id))
      .where(eq(task.projectId, projectId));
  }
}
