import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectLogger, PinoLogger } from '@pkg/server';
import {
  AGENT_TASK_TRANSITIONS,
  HUMAN_TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  type ActiveUser,
  type AddTaskCommentRequest,
  type AddTaskCommentResponse,
  type AddTaskDependencyRequest,
  type CheckCriterionRequest,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type GetTaskByIdResponse,
  type GetTaskPrRequest,
  type GetTaskPrResponse,
  type MergeTaskRequest,
  type MergeTaskResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type RemoveTaskDependencyRequest,
  type Task as TaskDto,
  type TaskAuthorType,
  type TaskComment as TaskCommentDto,
  type TaskStatus,
  type TransitionTaskRequest,
  type TransitionTaskResponse,
  type UpdateTaskRequest,
  type UpdateTaskResponse,
} from '@pkg/contracts';
import type { NewTask, Task, TaskComment } from '@pkg/database';
import { k } from '@pkg/locales';
import { GithubAppService } from '@pkg/server';
import { NotificationService } from '../notifications/notification.service';
import { OrgService } from '../org/org.service';
import { ProjectRepository } from './project.repository';
import { TaskRepository } from './task.repository';

const isTerminal = (status: TaskStatus): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

/**
 * The status protocol lives here. Every method takes the ACTOR — 'user' for
 * the web/REST surface, 'agent' for MCP tools — and the transition maps in
 * @pkg/contracts decide what each actor may do. The state machine, not
 * convention, is what stops an agent from approving its own work.
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly notificationService: NotificationService,
    private readonly orgService: OrgService,
    private readonly githubApp: GithubAppService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async create(activeUser: ActiveUser, dto: CreateTaskRequest): Promise<CreateTaskResponse> {
    const owner = await this.projectRepository.findById(dto.projectId, activeUser.orgId);
    if (!owner) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    if (owner.archivedAt) {
      throw new UnprocessableEntityException(k.tasks.errors.projectArchivedReadonly);
    }

    const created = await this.taskRepository.create({
      projectId: dto.projectId,
      title: dto.title,
      context: dto.context,
      outOfScope: dto.outOfScope,
      acceptanceCriteria: (dto.acceptanceCriteria ?? []).map((text) => ({ text, done: false })),
      priority: dto.priority ?? 0,
      createdBy: activeUser.userId,
    });

    this.logger.info({ taskId: created.id, title: created.title }, 'Task created');

    return this.serialize(created);
  }

  async list(activeUser: ActiveUser, dto: ListTasksRequest): Promise<ListTasksResponse> {
    const { data, total } = await this.taskRepository.findForOrg(activeUser.orgId, {
      skip: dto.skip,
      limit: dto.limit,
      projectId: dto.projectId,
      status: dto.status,
      available: dto.available,
    });

    return {
      data: data.map((t) => this.serialize(t)),
      meta: { total, skip: dto.skip, limit: dto.limit },
    };
  }

  async getById(activeUser: ActiveUser, id: string): Promise<GetTaskByIdResponse> {
    const found = await this.requireTask(id, activeUser.orgId);

    const [comments, dependencies, dependents] = await Promise.all([
      this.taskRepository.findComments(id),
      this.taskRepository.findDependencyInfo(id),
      this.taskRepository.findDependentInfo(id),
    ]);

    return {
      ...this.serialize(found),
      comments: comments.map((c) => this.serializeComment(c)),
      dependencies: dependencies as GetTaskByIdResponse['dependencies'],
      dependents: dependents as GetTaskByIdResponse['dependents'],
    };
  }

  async update(activeUser: ActiveUser, dto: UpdateTaskRequest): Promise<UpdateTaskResponse> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });
    if (isTerminal(current.status as TaskStatus)) {
      throw new UnprocessableEntityException(k.tasks.errors.terminalTask);
    }

    const { id, ...patch } = dto;
    const updated = await this.taskRepository.update(id, activeUser.orgId, patch as Partial<NewTask>);
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    return this.serialize(updated);
  }

  /**
   * The one door for status changes. Validates the actor's transition map,
   * enforces the two gates (dispatch, review), performs a compare-and-swap
   * so races lose cleanly, and records the accompanying comment.
   */
  async transition(
    activeUser: ActiveUser,
    actor: TaskAuthorType,
    dto: TransitionTaskRequest,
  ): Promise<TransitionTaskResponse> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });
    const from = current.status as TaskStatus;

    const map = actor === 'agent' ? AGENT_TASK_TRANSITIONS : HUMAN_TASK_TRANSITIONS;
    const allowed = map[from] ?? [];
    if (!allowed.includes(dto.to)) {
      throw new BadRequestException(k.tasks.errors.invalidTransition);
    }

    const comment = dto.comment?.trim();

    // Dispatch gate: capture is frictionless, dispatching is strict — an
    // agent must never pull a task without context and a definition of done.
    if (dto.to === 'ready' && from === 'draft') {
      if (!current.context?.trim() || current.acceptanceCriteria.length === 0) {
        throw new UnprocessableEntityException(k.tasks.errors.dispatchGate);
      }
    }

    // Review gate: no silent "done" claims. The summary comment plus the
    // branch/PR link is what makes review "open task → click PR → check".
    // Agent-only: the human's approved → needs_review is an undo, not a
    // submission — the task already carries its review payload.
    if (dto.to === 'needs_review' && actor === 'agent') {
      if (!comment || !current.branch?.trim() || !current.prUrl?.trim()) {
        throw new UnprocessableEntityException(k.tasks.errors.reviewGate);
      }
    }

    // A blocked task without the question, or a rejection without the
    // feedback, would stall the loop with no way to act on it.
    if (dto.to === 'blocked' && !comment) {
      throw new UnprocessableEntityException(k.tasks.errors.questionRequired);
    }
    if (dto.to === 'changes_requested' && !comment) {
      throw new UnprocessableEntityException(k.tasks.errors.feedbackRequired);
    }

    const patch: Partial<NewTask> = {
      status: dto.to,
      statusChangedBy: activeUser.userId,
      statusChangedAt: new Date(),
    };
    if (dto.to === 'in_progress' && !current.claimedBy) {
      // Entering work claims the task; a resume after blocked/feedback keeps
      // the original claim.
      patch.claimedBy = activeUser.userId;
      patch.claimedAt = new Date();
    }
    if (dto.to === 'ready') {
      // Re-queue always releases the claim — this is also the stale-claim reset.
      patch.claimedBy = null;
      patch.claimedAt = null;
    }

    const updated = await this.taskRepository.casUpdateStatus(dto.id, activeUser.orgId, from, patch);
    if (!updated) {
      throw new ConflictException(
        from === 'ready' && dto.to === 'in_progress'
          ? k.tasks.errors.alreadyClaimed
          : k.tasks.errors.statusConflict,
      );
    }

    if (comment) {
      // Entering blocked = the question; leaving blocked = the answer.
      await this.taskRepository.createComment({
        taskId: dto.id,
        authorId: activeUser.userId,
        authorType: actor,
        kind: dto.to === 'blocked' ? 'question' : from === 'blocked' ? 'answer' : 'comment',
        body: comment,
      });
    }

    this.logger.info({ taskId: dto.id, from, to: dto.to, actor }, 'Task transitioned');

    // The loop's throughput is bounded by how fast the human notices their
    // move — light the bell when a task enters the human court. Best-effort:
    // a notification failure must never fail the transition.
    if (dto.to === 'blocked' || dto.to === 'needs_review') {
      try {
        const members = await this.taskRepository.findOrgMemberIds(activeUser.orgId);
        const title =
          dto.to === 'blocked' ? `Question: ${updated.title}` : `Review: ${updated.title}`;
        const message = dto.to === 'blocked' ? comment! : (comment ?? null);
        await Promise.all(
          members
            .filter((memberId) => memberId !== activeUser.userId)
            .map((memberId) =>
              this.notificationService.create({
                userId: memberId,
                orgId: activeUser.orgId,
                type: dto.to === 'blocked' ? 'warning' : 'info',
                title,
                message: message ?? undefined,
                data: { taskId: dto.id, projectId: updated.projectId, to: dto.to },
              }),
            ),
        );
      } catch (error) {
        this.logger.warn({ taskId: dto.id, error }, 'Court notification failed');
      }
    }

    // Auto modes: the event may arrive with CI ALREADY green (the webhook
    // path covers green-arrives-later). Best-effort — never fails the
    // transition that triggered it.
    if (
      (dto.to === 'needs_review' && actor === 'agent') ||
      (dto.to === 'approved' && actor === 'user')
    ) {
      try {
        await this.maybeAutoProgress(activeUser, updated);
      } catch (error) {
        this.logger.warn({ taskId: dto.id, err: error }, 'Auto progression failed');
      }
    }

    return this.serialize(updated);
  }

  /**
   * Per-project auto modes, api side: when a submission or approval lands
   * with CI already green, progress it immediately instead of waiting for
   * the next webhook. `auto` promotes needs_review → approved first; both
   * auto modes then merge. Held while the circuit breaker (red default
   * branch) is set.
   */
  private async maybeAutoProgress(activeUser: ActiveUser, current: Task): Promise<void> {
    if (current.ciState !== 'passing' || current.prState === 'merged') return;
    const proj = await this.projectRepository.findById(current.projectId, activeUser.orgId);
    if (!proj || proj.mode === 'manual' || proj.autoPausedAt) return;

    let status = current.status as TaskStatus;
    if (status === 'needs_review') {
      if (proj.mode !== 'auto') return;
      const approved = await this.taskRepository.casUpdateStatus(
        current.id,
        activeUser.orgId,
        'needs_review',
        { status: 'approved', statusChangedAt: new Date() },
      );
      if (!approved) return;
      status = 'approved';
      this.logger.info({ taskId: current.id }, 'Auto: approved (CI green, mode=auto)');
    }
    if (status !== 'approved') return;
    await this.merge(activeUser, { id: current.id });
    this.logger.info({ taskId: current.id }, 'Auto: merged (task done)');
  }

  /**
   * The merge gate: approved → main, executed server-side with a
   * per-call-minted installation token — the browser never holds a GitHub
   * credential. GitHub's merge response is authoritative, so the task goes
   * `done` here immediately; the webhook's own merged event later is an
   * idempotent overwrite of the same values.
   */
  async merge(activeUser: ActiveUser, dto: MergeTaskRequest): Promise<MergeTaskResponse> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });
    if (current.status !== 'approved') {
      throw new UnprocessableEntityException(k.tasks.errors.mergeNotApproved);
    }
    if (current.ciState === 'failing') {
      throw new UnprocessableEntityException(k.tasks.errors.mergeCiFailing);
    }

    // Merged outside specbook (or webhook already stamped it): finalize only.
    if (current.prState === 'merged') {
      return this.finalizeMerged(activeUser, dto.id, current.prNumber);
    }

    const { connection, repoFullName, defaultBranch } = await this.githubRepoContext(
      activeUser.orgId,
      current.projectId,
    );

    // Resolve the PR: webhook-fed number first, then branch lookup, then
    // create one — the agent protocol guarantees a branch by review time.
    let prNumber = current.prNumber;
    if (!prNumber && current.branch) {
      const existing = await this.githubApp.getPullRequest(
        connection.installationId,
        repoFullName,
        { headBranch: current.branch },
      );
      if (existing?.state === 'merged') {
        return this.finalizeMerged(activeUser, dto.id, existing.number);
      }
      prNumber =
        existing?.state === 'open'
          ? existing.number
          : await this.githubApp.createPullRequest(connection.installationId, repoFullName, {
              head: current.branch,
              base: defaultBranch,
              title: current.title,
            });
    }
    if (!prNumber) {
      throw new UnprocessableEntityException(k.tasks.errors.mergeNoPr);
    }

    const merged = await this.githubApp.mergePullRequest(
      connection.installationId,
      repoFullName,
      prNumber,
    );
    if (!merged) {
      throw new ConflictException(k.tasks.errors.mergeConflict);
    }

    this.logger.info(
      { taskId: dto.id, repo: repoFullName, prNumber, userId: activeUser.userId },
      'Task PR merged',
    );
    return this.finalizeMerged(activeUser, dto.id, prNumber);
  }

  /** Scope-at-a-glance for the review card, live from GitHub at read time. */
  async getPr(activeUser: ActiveUser, dto: GetTaskPrRequest): Promise<GetTaskPrResponse> {
    const current = await this.requireTask(dto.id, activeUser.orgId);
    const { connection, repoFullName } = await this.githubRepoContext(
      activeUser.orgId,
      current.projectId,
    );

    const pr = current.prNumber
      ? await this.githubApp.getPullRequest(connection.installationId, repoFullName, {
          number: current.prNumber,
        })
      : current.branch
        ? await this.githubApp.getPullRequest(connection.installationId, repoFullName, {
            headBranch: current.branch,
          })
        : null;
    if (!pr) {
      throw new NotFoundException(k.tasks.errors.mergeNoPr);
    }
    return pr;
  }

  private async finalizeMerged(
    activeUser: ActiveUser,
    taskId: string,
    prNumber: number | null,
  ): Promise<TaskDto> {
    const updated = await this.taskRepository.update(taskId, activeUser.orgId, {
      status: 'done',
      prState: 'merged',
      prNumber,
      prSyncedAt: new Date(),
      statusChangedBy: activeUser.userId,
      statusChangedAt: new Date(),
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    return this.serialize(updated);
  }

  /**
   * The GitHub coordinates a task's merge/stats need. Bound projects carry
   * the repo directly; unbound ones fall back to parsing their free-text
   * repoUrl — the dogfood project predates binding.
   */
  private async githubRepoContext(
    orgId: string,
    projectId: string,
  ): Promise<{
    connection: { installationId: number };
    repoFullName: string;
    defaultBranch: string;
  }> {
    if (!this.githubApp.enabled) {
      throw new UnprocessableEntityException(k.tasks.errors.githubNotConnected);
    }
    const proj = await this.projectRepository.findById(projectId, orgId);
    if (!proj) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    const repoFullName =
      proj.githubRepoFullName ??
      /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(proj.repoUrl ?? '')?.[1] ??
      null;
    if (!repoFullName) {
      throw new UnprocessableEntityException(k.tasks.errors.projectNotBound);
    }
    const connection = await this.orgService.githubConnection(orgId);
    if (!connection) {
      throw new UnprocessableEntityException(k.tasks.errors.githubNotConnected);
    }
    return { connection, repoFullName, defaultBranch: proj.defaultBranch || 'main' };
  }

  async checkCriterion(activeUser: ActiveUser, dto: CheckCriterionRequest): Promise<TaskDto> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });
    if (isTerminal(current.status as TaskStatus)) {
      throw new UnprocessableEntityException(k.tasks.errors.terminalTask);
    }
    if (dto.index >= current.acceptanceCriteria.length) {
      throw new BadRequestException(k.tasks.errors.criterionNotFound);
    }

    const criteria = current.acceptanceCriteria.map((c, i) =>
      i === dto.index ? { ...c, done: dto.done } : c,
    );
    const updated = await this.taskRepository.update(dto.id, activeUser.orgId, {
      acceptanceCriteria: criteria,
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    return this.serialize(updated);
  }

  async addComment(
    activeUser: ActiveUser,
    actor: TaskAuthorType,
    dto: AddTaskCommentRequest,
  ): Promise<AddTaskCommentResponse> {
    await this.requireTask(dto.id, activeUser.orgId, { mutating: true });

    const created = await this.taskRepository.createComment({
      taskId: dto.id,
      authorId: activeUser.userId,
      authorType: actor,
      kind: dto.kind,
      body: dto.body,
    });

    return this.serializeComment(created);
  }

  async addDependency(activeUser: ActiveUser, dto: AddTaskDependencyRequest): Promise<void> {
    const [dependent, dependency] = await Promise.all([
      this.requireTask(dto.id, activeUser.orgId, { mutating: true }),
      this.taskRepository.findById(dto.dependsOnTaskId, activeUser.orgId),
    ]);
    if (!dependency) {
      throw new NotFoundException(k.tasks.errors.dependencyNotFound);
    }
    if (dependent.projectId !== dependency.projectId) {
      throw new BadRequestException(k.tasks.errors.dependencySameProject);
    }
    if (dto.id === dto.dependsOnTaskId) {
      throw new BadRequestException(k.tasks.errors.dependencyCycle);
    }

    // A cycle would deadlock the queue silently: every task in it waits for
    // another forever, and `available` simply never returns them. Walk the
    // project's edges before inserting.
    const edges = await this.taskRepository.findProjectDependencyEdges(dependent.projectId);
    if (this.wouldCycle(edges, dto.id, dto.dependsOnTaskId)) {
      throw new BadRequestException(k.tasks.errors.dependencyCycle);
    }

    await this.taskRepository.addDependency(dto.id, dto.dependsOnTaskId);
  }

  async removeDependency(activeUser: ActiveUser, dto: RemoveTaskDependencyRequest): Promise<void> {
    await this.requireTask(dto.id, activeUser.orgId, { mutating: true });
    const removed = await this.taskRepository.removeDependency(dto.id, dto.dependsOnTaskId);
    if (!removed) {
      throw new NotFoundException(k.tasks.errors.dependencyNotFound);
    }
  }

  async delete(activeUser: ActiveUser, id: string): Promise<void> {
    const current = await this.requireTask(id, activeUser.orgId, { mutating: true });
    // Anything past draft has history worth keeping — cancel, don't erase.
    if (current.status !== 'draft') {
      throw new UnprocessableEntityException(k.tasks.errors.onlyDraftDeletable);
    }
    await this.taskRepository.delete(id, activeUser.orgId);
    this.logger.info({ taskId: id }, 'Task deleted');
  }

  /** `mutating` enforces the archive boundary: an archived project is
   *  readonly — every task write bounces until it is unarchived. */
  private async requireTask(
    id: string,
    orgId: string,
    opts: { mutating?: boolean } = {},
  ): Promise<Task> {
    const found = await this.taskRepository.findById(id, orgId);
    if (!found) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    if (opts.mutating) {
      const owner = await this.projectRepository.findById(found.projectId, orgId);
      if (owner?.archivedAt) {
        throw new UnprocessableEntityException(k.tasks.errors.projectArchivedReadonly);
      }
    }
    return found;
  }

  /** true if dependsOnTaskId can already reach taskId through existing edges. */
  private wouldCycle(
    edges: Array<{ taskId: string; dependsOnTaskId: string }>,
    taskId: string,
    dependsOnTaskId: string,
  ): boolean {
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      const next = adjacency.get(e.taskId) ?? [];
      next.push(e.dependsOnTaskId);
      adjacency.set(e.taskId, next);
    }
    const queue = [dependsOnTaskId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const node = queue.pop()!;
      if (node === taskId) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      queue.push(...(adjacency.get(node) ?? []));
    }
    return false;
  }

  private serialize(t: Task): TaskDto {
    return {
      ...t,
      status: t.status as TaskStatus,
      prState: t.prState as TaskDto['prState'],
      ciState: t.ciState as TaskDto['ciState'],
      ciFailureKind: t.ciFailureKind as TaskDto['ciFailureKind'],
      claimedAt: t.claimedAt?.toISOString() ?? null,
      statusChangedAt: t.statusChangedAt?.toISOString() ?? null,
      prSyncedAt: t.prSyncedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private serializeComment(c: TaskComment): TaskCommentDto {
    return {
      ...c,
      authorType: c.authorType as TaskCommentDto['authorType'],
      kind: c.kind as TaskCommentDto['kind'],
      createdAt: c.createdAt.toISOString(),
    };
  }
}
