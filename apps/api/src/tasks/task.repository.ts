import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  organizationUser,
  project,
  research,
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
  isNotNull,
  type NewTask,
  type NewTaskComment,
  type Task,
  type TaskComment,
} from '@pkg/database';
import {
  DEPENDENCY_SATISFYING_STATUSES,
  MERGE_DEBT_CAP,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
} from '@pkg/contracts';

export interface ListTasksFilter {
  skip: number;
  limit: number;
  projectId?: string;
  status?: TaskStatus;
  available?: boolean;
  /** "My tasks": restrict to rows assigned to this user id (resolved from the
   *  session, never the payload). Org scoping still rides on the project join. */
  assigneeId?: string;
}

export interface DependencyInfoRow {
  id: string;
  title: string;
  status: string;
}

/** One edge row keyed by the owner task it belongs to (list read model). */
export interface EdgeSummaryRow extends DependencyInfoRow {
  ownerTaskId: string;
}

/**
 * A task row carrying its lineage: the title of the research it was cut from,
 * resolved via an org-scoped LEFT JOIN. Null when the task was filed directly
 * (or its source research was deleted — the FK is ON DELETE SET NULL).
 */
export type TaskWithSource = Task & { sourceResearchTitle: string | null };

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
   * The per-project visibility layer, BELOW org scoping. `restrictMemberId`
   * present = a human MEMBER whose reads are confined to granted projects
   * (deny-by-default). Absent = OWNER/ADMIN or an agent — no restriction. A
   * task carries no org/grant of its own, so the grant is checked on its owning
   * project. The caller derives the id via isProjectScopedIdentity, so a
   * machine identity is never scoped and the runner stays sighted.
   */
  private memberScope(restrictMemberId: string | undefined) {
    if (!restrictMemberId) return undefined;
    return sql`EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = ${task.projectId} AND pm.user_id = ${restrictMemberId}
    )`;
  }

  /**
   * The agent queue predicate: every prerequisite is SATISFIED. Only `done`
   * satisfies (DEPENDENCY_SATISFYING_STATUSES) — a killed prerequisite never
   * delivered its groundwork, so a `cancelled` dependency does NOT unblock and
   * is not silently treated as satisfied. The cancel path detaches the edge
   * from every non-terminal dependent, so in normal flow no live task waits on
   * a cancelled one; this predicate is the belt to that suspenders (a lingering
   * edge blocks rather than sails through). Single source: @pkg/contracts.
   */
  private noUnfinishedDependencies() {
    const satisfying = sql.join(
      DEPENDENCY_SATISFYING_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    return sql`NOT EXISTS (
      SELECT 1 FROM task_dependency d
      JOIN task dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = ${task.id} AND dep.status NOT IN (${satisfying})
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
    restrictMemberId?: string,
  ): Promise<{ data: TaskWithSource[]; total: number }> {
    const conditions = [eq(project.orgId, orgId)];
    if (filter.projectId) conditions.push(eq(task.projectId, filter.projectId));
    if (filter.status) conditions.push(eq(task.status, filter.status));
    if (filter.assigneeId) conditions.push(eq(task.assignee, filter.assigneeId));
    const memberScope = this.memberScope(restrictMemberId);
    if (memberScope) conditions.push(memberScope);
    if (filter.available) {
      // changes_requested is fed alongside ready: review rejections and
      // done-task reopens both carry their spec delta as the latest human
      // comment, and without this they sit invisible to runner sweeps.
      conditions.push(inArray(task.status, ['ready', 'changes_requested']));
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
        .select({ task, sourceResearchTitle: research.title })
        .from(task)
        .innerJoin(project, eq(task.projectId, project.id))
        // Lineage title, resolved inside the tenant: the join is pinned to the
        // same org, so a null source_research_id (or a foreign row) yields null.
        .leftJoin(research, and(eq(task.sourceResearchId, research.id), eq(research.orgId, orgId)))
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

    return {
      data: rows.map((r) => ({ ...r.task, sourceResearchTitle: r.sourceResearchTitle })),
      total: totalResult[0]?.count ?? 0,
    };
  }

  /**
   * The distinct non-null `area` labels used within one project, most-used
   * first — the form's autocomplete source. Org-scoped: the project is joined
   * on the owning org, so a foreign project id yields nothing.
   */
  async distinctAreas(orgId: string, projectId: string): Promise<string[]> {
    const rows = await this.dbClient.db
      .select({ area: task.area, n: count() })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(and(eq(project.orgId, orgId), eq(task.projectId, projectId), isNotNull(task.area)))
      .groupBy(task.area)
      .orderBy(desc(count()), asc(task.area));
    return rows.map((r) => r.area!).filter((a): a is string => a !== null);
  }

  async findById(
    id: string,
    orgId: string,
    restrictMemberId?: string,
  ): Promise<TaskWithSource | null> {
    const [row] = await this.dbClient.db
      .select({ task, sourceResearchTitle: research.title })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .leftJoin(research, and(eq(task.sourceResearchId, research.id), eq(research.orgId, orgId)))
      .where(and(eq(task.id, id), eq(project.orgId, orgId), this.memberScope(restrictMemberId)))
      .limit(1);

    return row ? { ...row.task, sourceResearchTitle: row.sourceResearchTitle } : null;
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

  /**
   * The NON-terminal dependents of a task (tasks that depend on it and are not
   * done/cancelled) — the set the cancel path must detach so no live task is
   * left waiting on a killed prerequisite. Org-scoped: the dependent is joined
   * to its project on `org_id`, so a task id from another org resolves to none.
   */
  async findNonTerminalDependents(
    dependsOnTaskId: string,
    orgId: string,
  ): Promise<DependencyInfoRow[]> {
    const terminal = sql.join(
      TERMINAL_TASK_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    return this.dbClient.db
      .select({ id: task.id, title: task.title, status: task.status })
      .from(taskDependency)
      .innerJoin(task, eq(task.id, taskDependency.taskId))
      .innerJoin(project, and(eq(task.projectId, project.id), eq(project.orgId, orgId)))
      .where(
        and(
          eq(taskDependency.dependsOnTaskId, dependsOnTaskId),
          sql`${task.status} NOT IN (${terminal})`,
        ),
      );
  }

  /**
   * Delete the dependency edges pointing at `dependsOnTaskId` from the given
   * dependent tasks — the detach half of the cancel path. The dependent ids
   * come from an org-scoped read (findNonTerminalDependents), so this delete
   * stays inside the tenant by construction.
   */
  async detachDependents(dependsOnTaskId: string, dependentTaskIds: string[]): Promise<void> {
    if (dependentTaskIds.length === 0) return;
    await this.dbClient.db
      .delete(taskDependency)
      .where(
        and(
          eq(taskDependency.dependsOnTaskId, dependsOnTaskId),
          inArray(taskDependency.taskId, dependentTaskIds),
        ),
      );
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

  /**
   * Edge summaries for a page of tasks, both directions at once — the board's
   * collapsed-row dependency indicators. For each owner id: its `dependencies`
   * (prerequisites it waits on) and its `dependents` (tasks that wait on it),
   * each carrying the far task's id/title/status so the row can label a count,
   * decide the "waiting" treatment, and list the chain in a tooltip.
   *
   * Org-scoped: the far task is joined to its project on `org_id`, so an owner
   * id from another org resolves to zero edges. Dependencies are same-project
   * by construction (the add path enforces it), so scoping the far end also
   * scopes the near end.
   */
  async findEdgeSummaries(
    orgId: string,
    taskIds: string[],
  ): Promise<{ dependencies: EdgeSummaryRow[]; dependents: EdgeSummaryRow[] }> {
    if (taskIds.length === 0) return { dependencies: [], dependents: [] };
    const [dependencies, dependents] = await Promise.all([
      this.dbClient.db
        .select({
          ownerTaskId: taskDependency.taskId,
          id: task.id,
          title: task.title,
          status: task.status,
        })
        .from(taskDependency)
        .innerJoin(task, eq(task.id, taskDependency.dependsOnTaskId))
        .innerJoin(project, and(eq(task.projectId, project.id), eq(project.orgId, orgId)))
        .where(inArray(taskDependency.taskId, taskIds)),
      this.dbClient.db
        .select({
          ownerTaskId: taskDependency.dependsOnTaskId,
          id: task.id,
          title: task.title,
          status: task.status,
        })
        .from(taskDependency)
        .innerJoin(task, eq(task.id, taskDependency.taskId))
        .innerJoin(project, and(eq(task.projectId, project.id), eq(project.orgId, orgId)))
        .where(inArray(taskDependency.dependsOnTaskId, taskIds)),
    ]);
    return { dependencies, dependents };
  }

  /** Member ids of an org — recipients for court-transition notifications. */
  async findOrgMemberIds(orgId: string): Promise<string[]> {
    const rows = await this.dbClient.db
      .select({ userId: organizationUser.userId })
      .from(organizationUser)
      .where(eq(organizationUser.orgId, orgId));
    return rows.map((r) => r.userId);
  }

  /**
   * Every task in a project, lean, for the bulk mark-ready resolver: the fields
   * the transitive-prerequisite walk and the dispatch gate need, nothing heavy
   * (context/criteria collapse to a `dispatchable` boolean in SQL). Org-scoped:
   * the project is joined on the owning org, so a foreign project id yields
   * nothing and the resolver promotes zero tasks.
   */
  async findProjectPromotionRows(
    orgId: string,
    projectId: string,
  ): Promise<
    Array<{ id: string; status: string; area: string | null; title: string; dispatchable: boolean }>
  > {
    const rows = await this.dbClient.db
      .select({
        id: task.id,
        status: task.status,
        area: task.area,
        title: task.title,
        // The dispatch gate, computed in SQL: non-empty context AND at least one
        // acceptance criterion — the same bar the single-task draft→ready
        // transition enforces before a task may be dispatched.
        dispatchable: sql<boolean>`(
          length(btrim(coalesce(${task.context}, ''))) > 0
          AND jsonb_array_length(${task.acceptanceCriteria}) > 0
        )`,
      })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(and(eq(project.orgId, orgId), eq(task.projectId, projectId)));
    return rows.map((r) => ({ ...r, dispatchable: Boolean(r.dispatchable) }));
  }

  /**
   * Bulk draft → ready, org-scoped and status-guarded: only rows still in
   * `draft`, still inside the caller's org (the membership subquery), and named
   * in `ids` move. The `status = 'draft'` predicate is a compare-and-swap — a
   * task another actor advanced in the meantime updates zero rows rather than
   * being yanked back. Returns the rows it actually promoted, so a foreign org
   * (or an already-advanced task) promotes nothing.
   */
  async bulkPromoteDraftsToReady(
    orgId: string,
    ids: string[],
    statusChangedBy: string,
  ): Promise<Array<{ id: string; title: string }>> {
    if (ids.length === 0) return [];
    return this.dbClient.db
      .update(task)
      .set({
        status: 'ready',
        claimedBy: null,
        claimedAt: null,
        statusChangedBy,
        statusChangedAt: new Date(),
      })
      .where(and(inArray(task.id, ids), eq(task.status, 'draft'), this.orgGuard(orgId)))
      .returning({ id: task.id, title: task.title });
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
