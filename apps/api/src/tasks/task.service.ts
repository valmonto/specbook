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
  type ListTaskAreasResponse,
  type GetTaskPrResponse,
  type MergeTaskRequest,
  type MergeTaskResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type MarkReadyRequest,
  type MarkReadyResponse,
  type RemoveTaskDependencyRequest,
  type ReportCostRequest,
  type Task as TaskDto,
  type TaskAuthorType,
  type TaskComment as TaskCommentDto,
  type TaskDependencyInfo,
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
import { TaskRepository, type EdgeSummaryRow, type TaskWithSource } from './task.repository';

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
      area: dto.area,
      acceptanceCriteria: (dto.acceptanceCriteria ?? []).map((text) => ({ text, done: false })),
      priority: dto.priority ?? 0,
      isHumanTask: dto.isHumanTask ?? false,
      createdBy: activeUser.userId,
    });

    this.logger.info({ taskId: created.id, title: created.title }, 'Task created');

    // Wire any requested "depends on" edges through the SAME guarded path the
    // add-dependency tool uses: each id is checked for existence, same-org,
    // same-project, self and cycle before its edge is inserted. A bad id
    // rejects the whole call (the fresh draft is left for the caller to fix).
    for (const dependsOnTaskId of dto.dependsOn ?? []) {
      await this.addDependency(activeUser, { id: created.id, dependsOnTaskId });
    }

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

    // The board's collapsed rows show dependency indicators, so the list read
    // model carries each task's edges (both directions) — one extra org-scoped
    // query for the whole page, grouped by owner here.
    const { dependencies, dependents } = await this.taskRepository.findEdgeSummaries(
      activeUser.orgId,
      data.map((t) => t.id),
    );
    const byOwner = (rows: EdgeSummaryRow[]): Map<string, TaskDependencyInfo[]> => {
      const map = new Map<string, TaskDependencyInfo[]>();
      for (const r of rows) {
        const list = map.get(r.ownerTaskId) ?? [];
        list.push({ id: r.id, title: r.title, status: r.status as TaskStatus });
        map.set(r.ownerTaskId, list);
      }
      return map;
    };
    const depMap = byOwner(dependencies);
    const dependentMap = byOwner(dependents);

    return {
      data: data.map((t) => ({
        ...this.serialize(t),
        dependencies: depMap.get(t.id) ?? [],
        dependents: dependentMap.get(t.id) ?? [],
      })),
      meta: { total, skip: dto.skip, limit: dto.limit },
    };
  }

  /**
   * The distinct area labels used on a project's tasks — the form's
   * autocomplete source. Requires the project to exist inside the tenant;
   * the repository read is org-scoped either way.
   */
  async listAreas(activeUser: ActiveUser, projectId: string): Promise<ListTaskAreasResponse> {
    const owner = await this.projectRepository.findById(projectId, activeUser.orgId);
    if (!owner) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    const areas = await this.taskRepository.distinctAreas(activeUser.orgId, projectId);
    return { areas };
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

  async update(
    activeUser: ActiveUser,
    dto: UpdateTaskRequest,
    actor: TaskAuthorType = 'user',
  ): Promise<UpdateTaskResponse> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });
    if (isTerminal(current.status as TaskStatus)) {
      throw new UnprocessableEntityException(k.tasks.errors.terminalTask);
    }

    const { id, ...patch } = dto;

    // Round 2 (a reopened task recording fresh links over a merged PR):
    // preserve round 1 in the activity log — the link columns are about to
    // be overwritten and the card would otherwise lose the shipped PR.
    const startsNewRound =
      dto.prUrl !== undefined &&
      dto.prUrl !== current.prUrl &&
      current.prUrl !== null &&
      current.prState === 'merged';
    if (startsNewRound) {
      await this.taskRepository.createComment({
        taskId: id,
        authorId: activeUser.userId,
        authorType: actor,
        kind: 'comment',
        body: `Previous round: branch ${current.branch ?? '—'}, PR ${current.prUrl} — merged.`,
      });
    }

    const repoPatch = patch as Partial<NewTask>;
    if (startsNewRound || (dto.prUrl !== undefined && dto.prUrl !== current.prUrl)) {
      // New PR, clean slate: the webhook re-fills these from the new PR's
      // events; carrying round 1's merged/green over would lie on the card.
      repoPatch.prState = null;
      repoPatch.prNumber = null;
      repoPatch.ciState = null;
      repoPatch.ciFailureKind = null;
      repoPatch.ciRetriedSha = null;
      repoPatch.prSyncedAt = null;
    }

    const updated = await this.taskRepository.update(id, activeUser.orgId, repoPatch);
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    return this.serialize(updated);
  }

  /**
   * The agent's spec-repair door: an agent edits ONLY the captured spec
   * fields (title, context, out-of-scope, area, acceptance criteria) of a
   * task it may still shape — a draft it filed, or a task it has claimed and
   * is working. Status, ownership, priority and the PR/branch links are out
   * of reach here (those move through transition / update_task_links), so a
   * spec fix can never smuggle a status change past the state machine. The
   * requireTask read is org-scoped, so a foreign org's task is a NotFound.
   */
  async agentUpdateSpec(
    activeUser: ActiveUser,
    dto: {
      id: string;
      title?: string;
      context?: string;
      outOfScope?: string;
      area?: string;
      acceptanceCriteria?: string[];
    },
  ): Promise<TaskDto> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });

    // Editable while the spec is still the agent's to shape: an undispatched
    // draft, or a task this same agent has claimed and is working. Anything
    // else (ready, needs_review, another agent's in_progress, a terminal
    // task) is off-limits — refine before dispatch or after re-claim.
    const editable =
      current.status === 'draft' ||
      (current.status === 'in_progress' && current.claimedBy === activeUser.userId);
    if (!editable) {
      throw new UnprocessableEntityException(k.tasks.errors.notEditable);
    }

    const patch: Partial<NewTask> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.context !== undefined) patch.context = dto.context;
    if (dto.outOfScope !== undefined) patch.outOfScope = dto.outOfScope;
    if (dto.area !== undefined) patch.area = dto.area;
    if (dto.acceptanceCriteria !== undefined) {
      // Full replacement, mirroring create(): a fresh checklist, all unticked.
      patch.acceptanceCriteria = dto.acceptanceCriteria.map((text) => ({ text, done: false }));
    }

    const updated = await this.taskRepository.update(dto.id, activeUser.orgId, patch);
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    this.logger.info({ taskId: dto.id }, 'Task spec edited by agent');
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
      // A steering note can never be silently shipped past: the agent must
      // read (get_notes acks) every note before submitting for review.
      if (await this.taskRepository.hasUnackedNotes(dto.id)) {
        throw new UnprocessableEntityException(k.tasks.errors.unackedNotes);
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

  /**
   * Agent-reported cost, ADDITIVE — the caller reports increments and the
   * columns accumulate. Claimant-only: the reporting identity must hold the
   * claim; anyone else is rejected, so a stray key cannot pollute another
   * agent's tally. The claim survives needs_review, so the final tally can
   * ride the submission itself.
   */
  async reportCost(activeUser: ActiveUser, dto: ReportCostRequest): Promise<TaskDto> {
    const current = await this.requireTask(dto.taskId, activeUser.orgId, { mutating: true });
    if (isTerminal(current.status as TaskStatus)) {
      throw new UnprocessableEntityException(k.tasks.errors.terminalTask);
    }
    if (current.claimedBy !== activeUser.userId) {
      throw new UnprocessableEntityException(k.tasks.errors.costNotClaimant);
    }
    const updated = await this.taskRepository.addCost(dto.taskId, activeUser.orgId, {
      tokensIn: dto.tokensIn,
      tokensOut: dto.tokensOut,
      usdCents: dto.usdCents,
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    this.logger.info(
      { taskId: dto.taskId, tokensIn: dto.tokensIn, tokensOut: dto.tokensOut, usdCents: dto.usdCents },
      'Cost reported',
    );
    return this.serialize(updated);
  }

  async addComment(
    activeUser: ActiveUser,
    actor: TaskAuthorType,
    dto: AddTaskCommentRequest,
  ): Promise<AddTaskCommentResponse> {
    const current = await this.requireTask(dto.id, activeUser.orgId, { mutating: true });

    // Notes are the human's steering channel INTO a working agent — agents
    // cannot author them, and they only make sense while someone is working.
    if (dto.kind === 'note') {
      if (actor !== 'user') {
        throw new UnprocessableEntityException(k.tasks.errors.noteHumanOnly);
      }
      if (current.status !== 'in_progress') {
        throw new UnprocessableEntityException(k.tasks.errors.noteNotInProgress);
      }
    }

    const created = await this.taskRepository.createComment({
      taskId: dto.id,
      authorId: activeUser.userId,
      authorType: actor,
      kind: dto.kind,
      body: dto.body,
    });

    return this.serializeComment(created);
  }

  /**
   * The claimant's read-and-ack of pending steering notes: returns every
   * unacked note on the claimed task and stamps acked_at in the same call —
   * "returned" IS "seen", so the needs_review gate can trust the timestamp.
   */
  async getNotes(activeUser: ActiveUser, taskId: string): Promise<TaskCommentDto[]> {
    const current = await this.requireTask(taskId, activeUser.orgId);
    if (current.claimedBy !== activeUser.userId) {
      throw new UnprocessableEntityException(k.tasks.errors.notesNotClaimant);
    }
    const notes = await this.taskRepository.ackNotes(taskId, activeUser.orgId);
    return notes.map((c) => this.serializeComment(c));
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

  /**
   * Bulk draft → ready behind three UI surfaces (project cog, per-Area group
   * menu, single-task action). Given a scope's target draft set, it also
   * promotes those targets' transitive DRAFT prerequisites, so a promoted task
   * is never left ready-but-stranded behind a draft it depends on (draft never
   * advances on its own — it is the human's holding pen).
   *
   * Human/UI-only: `ready` is the human dispatch gate, so no MCP tool wraps
   * this. Org comes from the session; the repository reads and the write are
   * org-scoped, so a foreign project/task promotes nothing.
   */
  async markReady(activeUser: ActiveUser, dto: MarkReadyRequest): Promise<MarkReadyResponse> {
    const { scope } = dto;
    const proj = await this.projectRepository.findById(scope.projectId, activeUser.orgId);
    if (!proj) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    if (proj.archivedAt) {
      throw new UnprocessableEntityException(k.tasks.errors.projectArchivedReadonly);
    }

    const [rows, edges] = await Promise.all([
      this.taskRepository.findProjectPromotionRows(activeUser.orgId, scope.projectId),
      this.taskRepository.findProjectDependencyEdges(scope.projectId),
    ]);

    const byId = new Map(rows.map((r) => [r.id, r]));
    const draftIds = new Set(rows.filter((r) => r.status === 'draft').map((r) => r.id));

    // The directly-requested target drafts, per scope. Non-draft (and, for the
    // `tasks` scope, foreign/other-project) ids are left untouched.
    let targetIds: string[];
    if (scope.kind === 'project') {
      targetIds = [...draftIds];
    } else if (scope.kind === 'area') {
      targetIds = rows
        .filter((r) => r.status === 'draft' && (r.area ?? null) === (scope.area ?? null))
        .map((r) => r.id);
    } else {
      targetIds = scope.taskIds.filter((id) => draftIds.has(id));
    }
    const targetSet = new Set(targetIds);

    // Walk transitive DRAFT prerequisites: from each target, follow depends-on
    // edges through draft nodes only. A non-draft prerequisite progresses on
    // its own and stops the chase — we never touch it (the queue gates
    // claimability on prerequisites being `done`, not `ready`, so ordering is
    // preserved). The graph is acyclic (wouldCycle rejects cycles at insert),
    // so the walk terminates.
    const dependsOn = new Map<string, string[]>();
    for (const e of edges) {
      const next = dependsOn.get(e.taskId) ?? [];
      next.push(e.dependsOnTaskId);
      dependsOn.set(e.taskId, next);
    }
    const reachableDrafts = new Set<string>();
    const stack = [...targetSet];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (reachableDrafts.has(node) || !draftIds.has(node)) continue;
      reachableDrafts.add(node);
      for (const prereq of dependsOn.get(node) ?? []) stack.push(prereq);
    }

    // Promote only drafts that clear the dispatch gate (non-empty context + at
    // least one criterion). A half-specified draft is left in draft rather than
    // dispatched — the same bar the single-task transition enforces.
    const promoteIds = [...reachableDrafts].filter((id) => byId.get(id)?.dispatchable);

    const promoted = await this.taskRepository.bulkPromoteDraftsToReady(
      activeUser.orgId,
      promoteIds,
      activeUser.userId,
    );

    // Prerequisites pulled in = promoted rows not directly in the requested scope.
    const prerequisites = promoted.filter((p) => !targetSet.has(p.id));

    this.logger.info(
      {
        projectId: scope.projectId,
        kind: scope.kind,
        promoted: promoted.length,
        prerequisites: prerequisites.length,
      },
      'Bulk mark-ready',
    );

    return { promoted, prerequisites };
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
  ): Promise<TaskWithSource> {
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

  private serialize(t: Task & { sourceResearchTitle?: string | null }): TaskDto {
    return {
      ...t,
      status: t.status as TaskStatus,
      // Present only on rows from the board/detail read path (the joined
      // title); other writes return a plain task, so default to null.
      sourceResearchId: t.sourceResearchId ?? null,
      sourceResearchTitle: t.sourceResearchTitle ?? null,
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
      ackedAt: c.ackedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
