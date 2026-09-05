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
  ASSIGNEE_TASK_TRANSITIONS,
  HUMAN_TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  isProjectScopedIdentity,
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
  type SyncTaskPrRequest,
  type SyncTaskPrResponse,
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
import { NotificationService } from '../notifications/notification.service.js';
import { OrgService } from '../org/org.service.js';
import { ProjectRepository } from './project.repository.js';
import { ProjectMemberRepository } from './project-member.repository.js';
import { TaskRepository, type EdgeSummaryRow, type TaskWithSource } from './task.repository.js';

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
    private readonly projectMemberRepository: ProjectMemberRepository,
    private readonly notificationService: NotificationService,
    private readonly orgService: OrgService,
    private readonly githubApp: GithubAppService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  /**
   * The member id a read/write must be confined to, or undefined for all-access.
   * A human MEMBER is scoped to their granted projects; OWNER/ADMIN and agents
   * (isAgent) are never scoped — the dispatch runner must see every project.
   */
  private scopeFor(activeUser: ActiveUser): string | undefined {
    return isProjectScopedIdentity(activeUser) ? activeUser.userId : undefined;
  }

  async create(activeUser: ActiveUser, dto: CreateTaskRequest): Promise<CreateTaskResponse> {
    // Scoped so a MEMBER cannot file into a project they were never granted —
    // a foreign project id behaves exactly like a missing one.
    const owner = await this.projectRepository.findById(
      dto.projectId,
      activeUser.orgId,
      this.scopeFor(activeUser),
    );
    if (!owner) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    if (owner.archivedAt) {
      throw new UnprocessableEntityException(k.tasks.errors.projectArchivedReadonly);
    }

    if (dto.assignee) {
      await this.assertAssignableToProject(activeUser.orgId, dto.projectId, dto.assignee);
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
      assignee: dto.assignee ?? null,
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
    const { data, total } = await this.taskRepository.findForOrg(
      activeUser.orgId,
      {
        skip: dto.skip,
        limit: dto.limit,
        projectId: dto.projectId,
        status: dto.status,
        available: dto.available,
        // "My tasks": the assignee id is the SESSION user, never a payload field.
        assigneeId: dto.assignedToMe ? activeUser.userId : undefined,
      },
      this.scopeFor(activeUser),
    );

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
    const owner = await this.projectRepository.findById(
      projectId,
      activeUser.orgId,
      this.scopeFor(activeUser),
    );
    if (!owner) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    const areas = await this.taskRepository.distinctAreas(activeUser.orgId, projectId);
    return { areas };
  }

  async getById(activeUser: ActiveUser, id: string): Promise<GetTaskByIdResponse> {
    const found = await this.requireTask(id, activeUser);

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
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });
    if (isTerminal(current.status as TaskStatus)) {
      throw new UnprocessableEntityException(k.tasks.errors.terminalTask);
    }

    const { id, ...patch } = dto;

    // Reassignment stays inside the tenant AND inside the project: a non-null
    // assignee must be able to SEE this task's project (null = unassign, always
    // allowed). A member without a grant on the project cannot be handed work in it.
    if (dto.assignee) {
      await this.assertAssignableToProject(activeUser.orgId, current.projectId, dto.assignee);
    }

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
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });

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
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });
    const from = current.status as TaskStatus;

    // The assignee of a human task is an EXECUTOR (like an agent): they get the
    // executor moves (start work, request review), NOT the owner's court moves
    // (approve/merge/promote). Every other human — the owner/reviewer — gets
    // HUMAN_TASK_TRANSITIONS. This is what stops a MEMBER assignee approving
    // their own work at the state-machine layer, alongside the permission gates.
    const isAssigneeExecutor =
      actor === 'user' && current.isHumanTask && current.assignee === activeUser.userId;
    const map =
      actor === 'agent'
        ? AGENT_TASK_TRANSITIONS
        : isAssigneeExecutor
          ? ASSIGNEE_TASK_TRANSITIONS
          : HUMAN_TASK_TRANSITIONS;
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

    // Human worker lane review gate: an assignee submitting their human task for
    // the owner's review must have linked the PR first (the review IS "open the
    // PR and evaluate"). Lighter than the agent gate — no summary/branch/notes
    // ceremony — but the PR link is non-negotiable.
    if (dto.to === 'needs_review' && isAssigneeExecutor && !current.prUrl?.trim()) {
      throw new UnprocessableEntityException(k.tasks.errors.humanReviewGate);
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

    const updated = await this.taskRepository.casUpdateStatus(
      dto.id,
      activeUser.orgId,
      from,
      patch,
    );
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

    // Cancelling severs live edges: a cancelled prerequisite delivered nothing,
    // so every non-terminal dependent is detached and told why. This guarantees
    // no active task is left waiting on a killed task (the "silently satisfied"
    // foot-gun), and no dangling tombstone edge remains on the board.
    if (dto.to === 'cancelled') {
      await this.detachCancelledDependents(activeUser, actor, updated);
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

    // Bootstrap the review PR: entering needs_review in an auto mode with a
    // branch but no PR is exactly the deadlock this closes — no PR means no CI
    // means the webhook's autoProgress never fires. Open (or adopt) the PR
    // here so CI can run and the reliable green-CI path carries it to done.
    // Best-effort: a failure is logged and leaves the task in needs_review.
    if (dto.to === 'needs_review' && actor === 'agent') {
      try {
        await this.maybeOpenReviewPr(activeUser, updated);
      } catch (error) {
        this.logger.warn(
          { taskId: dto.id, err: error },
          'Opening review PR failed — task left in needs_review for a human',
        );
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
   * The cancel fan-out: detach the just-cancelled task from each of its
   * non-terminal dependents and record a comment on each so the reason is on
   * the activity log. Terminal dependents (done/cancelled) keep their edge —
   * their history is settled and no queue decision rides on it. Org-scoped: the
   * dependent set comes from an org-scoped read, so a foreign task is untouched.
   */
  private async detachCancelledDependents(
    activeUser: ActiveUser,
    actor: TaskAuthorType,
    cancelled: Task,
  ): Promise<void> {
    const dependents = await this.taskRepository.findNonTerminalDependents(
      cancelled.id,
      activeUser.orgId,
    );
    if (dependents.length === 0) return;

    await this.taskRepository.detachDependents(
      cancelled.id,
      dependents.map((d) => d.id),
    );

    for (const dependent of dependents) {
      await this.taskRepository.createComment({
        taskId: dependent.id,
        authorId: activeUser.userId,
        authorType: actor,
        kind: 'comment',
        body: `Dependency "${cancelled.title}" was cancelled — the dependency was removed automatically.`,
      });
    }

    this.logger.info(
      { taskId: cancelled.id, detached: dependents.length },
      'Cancelled task detached from its non-terminal dependents',
    );
  }

  /**
   * The bootstrap fix: when a task enters needs_review in an auto mode with a
   * branch but no PR yet, open (or adopt) the PR so CI can run. Without this
   * the loop deadlocks — the agent may have recorded only a compare link (no
   * real PR), and no PR means no CI means the webhook's autoProgress never
   * fires, so the task sits in needs_review forever. Opening it here fires CI,
   * and the existing green-CI path (webhook autoProgress / maybeAutoProgress)
   * carries it the rest of the way.
   *
   * Idempotent: an already-open PR for the branch is adopted, never duplicated;
   * a branch already merged out-of-band finalizes the task to done. The
   * assumption-flag hold is NOT applied here — a flagged task still gets a PR
   * (so a human can review the diff); the merge is what waits (see
   * maybeAutoProgress / the worker's autoProgress). Best-effort by design: the
   * caller logs any throw and leaves the task in needs_review — a legible stop,
   * never a silent stall. Non-auto and human-lane tasks are untouched.
   */
  private async maybeOpenReviewPr(activeUser: ActiveUser, current: Task): Promise<void> {
    // Human worker lane: the intern opens and merges his own PR — never the
    // platform. Mirrors the isHumanTask exclusion in the auto engine.
    if (current.isHumanTask) return;
    // Already has a PR, or nothing to open one from, or already merged.
    if (current.prNumber || !current.branch?.trim() || current.prState === 'merged') return;
    if (!this.githubApp.enabled) return;

    const proj = await this.projectRepository.findById(current.projectId, activeUser.orgId);
    if (!proj || (proj.mode !== 'auto' && proj.mode !== 'auto_merge')) return;

    const { connection, repoFullName, defaultBranch } = await this.githubRepoContext(
      activeUser.orgId,
      current.projectId,
    );

    // Adopt an existing PR for the branch before opening a new one — a redeliver
    // or a race must never create a duplicate.
    const existing = await this.githubApp.getPullRequest(connection.installationId, repoFullName, {
      headBranch: current.branch,
    });
    if (existing?.state === 'merged') {
      await this.finalizeMerged(activeUser, current.id, existing.number);
      this.logger.info(
        { taskId: current.id, prNumber: existing.number },
        'Auto: branch already merged out-of-band — task finalized to done',
      );
      return;
    }

    let prNumber: number;
    let prUrl: string;
    if (existing?.state === 'open') {
      prNumber = existing.number;
      prUrl = existing.url;
    } else {
      prNumber = await this.githubApp.createPullRequest(connection.installationId, repoFullName, {
        head: current.branch,
        base: defaultBranch,
        title: current.title,
      });
      prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
    }

    const updated = await this.taskRepository.update(current.id, activeUser.orgId, {
      prNumber,
      prUrl,
      prState: 'open',
      prSyncedAt: new Date(),
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    this.logger.info(
      { taskId: current.id, prNumber, adopted: existing?.state === 'open' },
      'Auto: opened review PR (needs_review, auto mode) — CI will drive it to done',
    );
  }

  /**
   * Per-project auto modes, api side: when a submission or approval lands
   * with CI already green, progress it immediately instead of waiting for
   * the next webhook. `auto` promotes needs_review → approved first; both
   * auto modes then merge. Held while the circuit breaker (red default
   * branch) is set.
   */
  private async maybeAutoProgress(activeUser: ActiveUser, current: Task): Promise<void> {
    // Human worker lane: the owner reviews, never the auto-reviewer, and the
    // intern merges his own approved PR — so a human task never auto-approves or
    // auto-merges, whatever the project mode. This is the api-side half of the
    // isHumanTask gate; the worker's autoProgress excludes them too.
    if (current.isHumanTask) return;
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
    // The assumption-flag safety valve: a task shipped on a flagged assumption
    // is NEVER auto-merged, even in full-auto. Auto-review may still run (the
    // approve above), but the MERGE waits for a human who reads the assumption
    // and clears the flag. Additive hold — it weakens no review gate.
    if (current.assumptionFlag) {
      this.logger.info(
        { taskId: current.id },
        'Auto-merge held: task carries an assumption flag — routed to human review',
      );
      return;
    }
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
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });
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
    const current = await this.requireTask(dto.id, activeUser);
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

  /**
   * Pull-on-click PR sync — the human worker lane's on-demand alternative to
   * the webhook: read the linked PR's current state from GitHub (a READ, safe
   * for a MEMBER assignee to trigger) and stamp prState/prNumber/prSyncedAt onto
   * the task, writing the SAME fields the webhook worker does so webhooks can be
   * layered on later. CI is left "unknown" (null) — the installation token can't
   * read checks, but the pulls API IS readable, so merged/open drives status:
   *   - merged   → the task advances to `done` (a machine fact, like merge()).
   *   - closed   → flagged with a comment, never silently completed.
   *   - open     → fields refreshed; status untouched.
   * Org-scoped via requireTask; a foreign task id is a NotFound.
   */
  async syncPr(activeUser: ActiveUser, dto: SyncTaskPrRequest): Promise<SyncTaskPrResponse> {
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });
    if (!current.prNumber && !current.branch?.trim()) {
      throw new UnprocessableEntityException(k.tasks.errors.syncNoPr);
    }

    const { connection, repoFullName } = await this.githubRepoContext(
      activeUser.orgId,
      current.projectId,
    );

    const pr = current.prNumber
      ? await this.githubApp.getPullRequest(connection.installationId, repoFullName, {
          number: current.prNumber,
        })
      : await this.githubApp.getPullRequest(connection.installationId, repoFullName, {
          headBranch: current.branch!,
        });
    if (!pr) {
      throw new UnprocessableEntityException(k.tasks.errors.syncNoPr);
    }

    this.logger.info(
      { taskId: dto.id, prNumber: pr.number, prState: pr.state },
      'PR synced (pull-on-click)',
    );

    // Merged is terminal truth: advance to done (same finalize the merge path
    // uses), and record that the sync — not an auto-merge — completed it.
    if (pr.state === 'merged') {
      const done = await this.finalizeMerged(activeUser, dto.id, pr.number);
      await this.taskRepository.createComment({
        taskId: dto.id,
        authorId: activeUser.userId,
        authorType: 'user',
        kind: 'comment',
        body: `Synced: PR #${pr.number} is merged — task marked done.`,
      });
      return done;
    }

    // Open or closed: refresh the live fields, but never advance status here.
    const updated = await this.taskRepository.update(dto.id, activeUser.orgId, {
      prState: pr.state,
      prNumber: pr.number,
      prSyncedAt: new Date(),
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }

    // A closed-but-unmerged PR is a dead end, not a completion — flag it so the
    // owner sees it needs a reopened or freshly linked PR, and it is NOT done.
    if (pr.state === 'closed') {
      await this.taskRepository.createComment({
        taskId: dto.id,
        authorId: activeUser.userId,
        authorType: 'user',
        kind: 'comment',
        body: `Synced: PR #${pr.number} was closed without merging — not completed. Reopen it or link a new PR.`,
      });
    }

    return this.serialize(updated);
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
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });
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
    const current = await this.requireTask(dto.taskId, activeUser, { mutating: true });
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
      {
        taskId: dto.taskId,
        tokensIn: dto.tokensIn,
        tokensOut: dto.tokensOut,
        usdCents: dto.usdCents,
      },
      'Cost reported',
    );
    return this.serialize(updated);
  }

  /**
   * The proceed-flagged path: an agent records a REVERSIBLE judgment call on a
   * task it has claimed instead of hard-blocking. Claimant-only in the agent
   * court (the assumption belongs to the session that made the call), and never
   * on a terminal task. The flag's presence is what holds the task out of
   * full-auto's auto-merge (see maybeAutoProgress / the webhook worker). The
   * repository write is org-scoped, so a foreign org's task is a NotFound.
   */
  async setAssumption(
    activeUser: ActiveUser,
    actor: TaskAuthorType,
    dto: { id: string; what: string; why: string; howToVerify: string },
  ): Promise<TaskDto> {
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });
    if (isTerminal(current.status as TaskStatus)) {
      throw new UnprocessableEntityException(k.tasks.errors.terminalTask);
    }
    if (actor === 'agent' && current.claimedBy !== activeUser.userId) {
      throw new UnprocessableEntityException(k.tasks.errors.assumptionNotClaimant);
    }
    const updated = await this.taskRepository.update(dto.id, activeUser.orgId, {
      assumptionFlag: { what: dto.what, why: dto.why, howToVerify: dto.howToVerify },
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    this.logger.info({ taskId: dto.id }, 'Assumption flag set');
    return this.serialize(updated);
  }

  /**
   * Clearing is a HUMAN action — the review-time veto. Once cleared, the task
   * is free to auto-merge again (or the human merges it directly). Org-scoped.
   */
  async clearAssumption(activeUser: ActiveUser, id: string): Promise<TaskDto> {
    await this.requireTask(id, activeUser, { mutating: true });
    const updated = await this.taskRepository.update(id, activeUser.orgId, {
      assumptionFlag: null,
    });
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    this.logger.info({ taskId: id }, 'Assumption flag cleared');
    return this.serialize(updated);
  }

  async addComment(
    activeUser: ActiveUser,
    actor: TaskAuthorType,
    dto: AddTaskCommentRequest,
  ): Promise<AddTaskCommentResponse> {
    const current = await this.requireTask(dto.id, activeUser, { mutating: true });

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
    const current = await this.requireTask(taskId, activeUser);
    if (current.claimedBy !== activeUser.userId) {
      throw new UnprocessableEntityException(k.tasks.errors.notesNotClaimant);
    }
    const notes = await this.taskRepository.ackNotes(taskId, activeUser.orgId);
    return notes.map((c) => this.serializeComment(c));
  }

  async addDependency(activeUser: ActiveUser, dto: AddTaskDependencyRequest): Promise<void> {
    const [dependent, dependency] = await Promise.all([
      this.requireTask(dto.id, activeUser, { mutating: true }),
      this.taskRepository.findById(
        dto.dependsOnTaskId,
        activeUser.orgId,
        this.scopeFor(activeUser),
      ),
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
    await this.requireTask(dto.id, activeUser, { mutating: true });
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
    const proj = await this.projectRepository.findById(
      scope.projectId,
      activeUser.orgId,
      this.scopeFor(activeUser),
    );
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
    const current = await this.requireTask(id, activeUser, { mutating: true });
    // Anything past draft has history worth keeping — cancel, don't erase.
    if (current.status !== 'draft') {
      throw new UnprocessableEntityException(k.tasks.errors.onlyDraftDeletable);
    }
    await this.taskRepository.delete(id, activeUser.orgId);
    this.logger.info({ taskId: id }, 'Task deleted');
  }

  /**
   * The assignment gate: a task may only be assigned to a user who can SEE its
   * project — an org OWNER/ADMIN (all projects) or a MEMBER granted this one.
   * A non-org-member is rejected with the org-boundary message; an org member
   * without the project grant with the project-scope one. Both reads are
   * org-scoped, so a foreign user id can never slip through.
   */
  private async assertAssignableToProject(
    orgId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.projectMemberRepository.isOrgMember(orgId, userId))) {
      throw new BadRequestException(k.tasks.errors.assigneeNotMember);
    }
    if (!(await this.projectMemberRepository.canAccessProject(orgId, projectId, userId))) {
      throw new BadRequestException(k.tasks.errors.assigneeNotProjectMember);
    }
  }

  /**
   * The single choke for a task read/mutation. It gates BOTH planes at once:
   * org scoping AND the per-project visibility grant (a human MEMBER only ever
   * resolves a task whose project they were granted; OWNER/ADMIN and agents are
   * unrestricted). A task outside the caller's visibility behaves exactly like a
   * missing one — no leak via a direct `:id`. `mutating` also enforces the
   * archive boundary: an archived project is readonly until unarchived.
   */
  private async requireTask(
    id: string,
    activeUser: ActiveUser,
    opts: { mutating?: boolean } = {},
  ): Promise<TaskWithSource> {
    const restrict = this.scopeFor(activeUser);
    const found = await this.taskRepository.findById(id, activeUser.orgId, restrict);
    if (!found) {
      throw new NotFoundException(k.tasks.errors.notFound);
    }
    if (opts.mutating) {
      const owner = await this.projectRepository.findById(
        found.projectId,
        activeUser.orgId,
        restrict,
      );
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
      assumptionFlag: t.assumptionFlag ?? null,
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
