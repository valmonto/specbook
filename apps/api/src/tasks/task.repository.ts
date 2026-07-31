import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
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
  type NewTask,
  type NewTaskComment,
  type Task,
  type TaskComment,
} from '@pkg/database';
import type { TaskStatus } from '@pkg/contracts';

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
      conditions.push(this.noUnfinishedDependencies());
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
