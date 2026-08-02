import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  organization,
  project,
  task,
  and,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from '@pkg/database';
import {
  GITHUB_WEBHOOK_QUEUE,
  GithubAppService,
  InjectLogger,
  PinoLogger,
  type GithubWebhookJobPayload,
} from '@pkg/server';

interface ProjectRow {
  id: string;
  mode: string;
  defaultBranch: string;
  autoPausedAt: Date | null;
}

/**
 * Turns normalized GitHub events into live task state. Tenancy is the whole
 * game here: the chain is installationId → the ONE organization that stores
 * it → that org's projects on the event's repo → their tasks. An event can
 * never touch another org's tasks because the org is resolved first and every
 * further predicate narrows within it.
 *
 * Matching, within the org + repo: a task is affected when its `branch`
 * equals the PR's head branch, or its `prUrl` equals the PR's URL (compare
 * links recorded before a PR exists match by branch). Unmatched events are
 * dropped at debug — most pushes to a repo have no specbook task, and that
 * is normal, not an error. State writes are plain overwrites, so BullMQ
 * retries and GitHub redeliveries are naturally idempotent.
 *
 * AUTO MODES live here too, because this worker is the one place every CI
 * and PR event flows through:
 * - `auto`:       a needs_review task whose CI is green approves and merges
 *                 itself (the merge uses the same per-call-minted token seam
 *                 as the api's merge endpoint).
 * - `auto_merge`: a human-approved task merges itself once CI is green.
 * - Circuit breaker: a failing workflow run on the project's DEFAULT branch
 *   sets `auto_paused_at` — all auto progression holds until a green default-
 *   branch run clears it. A red main must not accumulate more merges.
 */
@Processor(GITHUB_WEBHOOK_QUEUE.name, GITHUB_WEBHOOK_QUEUE.workerOptions)
export class GithubWebhookProcessor extends WorkerHost {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
    private readonly githubApp: GithubAppService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<GithubWebhookJobPayload>): Promise<{ matched: number }> {
    const event = job.data;

    const [org] = await this.dbClient.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.githubInstallationId, event.installationId))
      .limit(1);

    if (!org) {
      this.logger.debug(
        { installationId: event.installationId, deliveryId: event.deliveryId },
        'GitHub event dropped: no organization holds this installation',
      );
      return { matched: 0 };
    }

    // The event's repo, within the resolved org only. Bound projects match
    // exactly; unbound ones match when their free-text repoUrl points at the
    // same repo (with or without .git).
    const repoUrl = `https://github.com/${event.repoFullName}`;
    const projects: ProjectRow[] = await this.dbClient.db
      .select({
        id: project.id,
        mode: project.mode,
        defaultBranch: project.defaultBranch,
        autoPausedAt: project.autoPausedAt,
      })
      .from(project)
      .where(
        and(
          eq(project.orgId, org.id),
          or(
            eq(project.githubRepoFullName, event.repoFullName),
            eq(project.repoUrl, repoUrl),
            eq(project.repoUrl, `${repoUrl}.git`),
          ),
        ),
      );

    if (projects.length === 0) {
      this.logger.debug(
        { repo: event.repoFullName, deliveryId: event.deliveryId },
        'GitHub event dropped: no project on this repo',
      );
      return { matched: 0 };
    }

    const matched =
      event.kind === 'pull_request'
        ? await this.applyPullRequest(projects, event)
        : await this.applyWorkflowRun(projects, event);

    this.logger.info(
      { kind: event.kind, repo: event.repoFullName, matched, deliveryId: event.deliveryId },
      'GitHub event applied',
    );
    return { matched };
  }

  private async applyPullRequest(
    projects: ProjectRow[],
    event: Extract<GithubWebhookJobPayload, { kind: 'pull_request' }>,
  ): Promise<number> {
    const projectIds = projects.map((p) => p.id);
    const rows = await this.dbClient.db
      .update(task)
      .set({
        prState: event.prState,
        prNumber: event.prNumber,
        prSyncedAt: new Date(),
        // A task matched by branch gets its prUrl filled — the agent may have
        // recorded only the branch before the PR existed. Never overwrites.
        prUrl: sql`COALESCE(${task.prUrl}, ${event.prUrl || null})`,
      })
      .where(
        and(
          inArray(task.projectId, projectIds),
          or(eq(task.branch, event.headBranch), eq(task.prUrl, event.prUrl)),
        ),
      )
      .returning({ id: task.id });

    // done = MERGED. A merge event completes matched tasks sitting in
    // `approved` (the merge queue) — the only status the webhook may move,
    // and only forward; review states are the human's alone. Idempotent:
    // a redelivery finds status already `done` and updates zero rows.
    if (event.prState === 'merged' && rows.length > 0) {
      const completed = await this.dbClient.db
        .update(task)
        .set({ status: 'done', statusChangedAt: new Date() })
        .where(
          and(
            inArray(
              task.id,
              rows.map((r) => r.id),
            ),
            eq(task.status, 'approved'),
          ),
        )
        .returning({ id: task.id });
      if (completed.length > 0) {
        this.logger.info(
          { taskIds: completed.map((t) => t.id), prNumber: event.prNumber },
          'Merged PR completed approved task(s)',
        );
      }
    }

    // A PR opened AFTER its branch already went green: the auto modes may
    // now progress the matched tasks.
    if (event.prState === 'open' && rows.length > 0) {
      await this.autoProgress(
        projects,
        event.installationId,
        event.repoFullName,
        rows.map((r) => r.id),
      );
    }
    return rows.length;
  }

  private async applyWorkflowRun(
    projects: ProjectRow[],
    event: Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }>,
  ): Promise<number> {
    // Circuit breaker: default-branch runs gate ALL auto progression for
    // their project. Red trips it (keeping the FIRST trip time), green
    // resets it. Feature-branch runs never touch it.
    for (const p of projects) {
      if (p.mode === 'manual' || event.headBranch !== p.defaultBranch) continue;
      if (event.ciState === 'failing' && !p.autoPausedAt) {
        await this.dbClient.db
          .update(project)
          .set({ autoPausedAt: new Date() })
          .where(and(eq(project.id, p.id), isNull(project.autoPausedAt)));
        p.autoPausedAt = new Date();
        this.logger.warn(
          { projectId: p.id, branch: event.headBranch },
          'Auto progression paused: default branch is red',
        );
      } else if (event.ciState === 'passing' && p.autoPausedAt) {
        await this.dbClient.db
          .update(project)
          .set({ autoPausedAt: null })
          .where(eq(project.id, p.id));
        p.autoPausedAt = null;
        this.logger.info({ projectId: p.id }, 'Auto progression resumed: default branch green');
      }
    }

    // Push-triggered runs on main (post-merge deploys) carry the base branch;
    // only annotate tasks that actually name this branch. PR numbers refine
    // the match when GitHub provides them.
    const projectIds = projects.map((p) => p.id);
    const branchMatch = eq(task.branch, event.headBranch);
    const match =
      event.prNumbers.length > 0
        ? or(branchMatch, inArray(task.prNumber, event.prNumbers))
        : branchMatch;

    const rows = await this.dbClient.db
      .update(task)
      .set({ ciState: event.ciState, prSyncedAt: new Date() })
      .where(and(inArray(task.projectId, projectIds), match))
      .returning({ id: task.id });

    if (event.ciState === 'passing' && rows.length > 0) {
      await this.autoProgress(
        projects,
        event.installationId,
        event.repoFullName,
        rows.map((r) => r.id),
      );
    }
    return rows.length;
  }

  /**
   * The auto-mode engine: for each candidate task (CI green, not merged),
   * `auto` promotes needs_review → approved, then both auto modes merge
   * approved tasks — sequentially, so each merge lands before the next is
   * attempted. A merge GitHub refuses (conflict, rule) is logged and left
   * in `approved` for the human; nothing retries blindly.
   */
  private async autoProgress(
    projects: ProjectRow[],
    installationId: number,
    repoFullName: string,
    taskIds: string[],
  ): Promise<void> {
    const autoProjects = projects.filter((p) => p.mode === 'auto' || p.mode === 'auto_merge');
    if (autoProjects.length === 0) return;
    if (!this.githubApp.enabled) {
      this.logger.warn(
        { repo: repoFullName },
        'Auto mode set but GITHUB_APP_* env is absent on the worker — cannot merge',
      );
      return;
    }
    const byId = new Map(autoProjects.map((p) => [p.id, p]));

    const candidates = await this.dbClient.db
      .select()
      .from(task)
      .where(
        and(
          inArray(task.id, taskIds),
          inArray(
            task.projectId,
            autoProjects.map((p) => p.id),
          ),
          inArray(task.status, ['needs_review', 'approved']),
          eq(task.ciState, 'passing'),
        ),
      );

    for (const t of candidates) {
      const proj = byId.get(t.projectId);
      if (!proj) continue;
      if (proj.autoPausedAt) {
        this.logger.debug({ taskId: t.id }, 'Auto progression held: project paused (red main)');
        continue;
      }
      if (t.status === 'needs_review' && proj.mode !== 'auto') continue;
      if (t.prState === 'merged') continue;

      try {
        if (t.status === 'needs_review') {
          const [approved] = await this.dbClient.db
            .update(task)
            .set({ status: 'approved', statusChangedAt: new Date() })
            .where(and(eq(task.id, t.id), eq(task.status, 'needs_review')))
            .returning({ id: task.id });
          if (!approved) continue; // lost a race — someone else moved it
          this.logger.info({ taskId: t.id }, 'Auto: approved (CI green, mode=auto)');
        }

        // Resolve the PR: webhook-fed number, else by branch, else create it.
        let prNumber = t.prNumber;
        if (!prNumber && t.branch) {
          const existing = await this.githubApp.getPullRequest(installationId, repoFullName, {
            headBranch: t.branch,
          });
          if (existing?.state === 'merged') {
            await this.finalizeMerged(t.id, existing.number);
            continue;
          }
          prNumber =
            existing?.state === 'open'
              ? existing.number
              : await this.githubApp.createPullRequest(installationId, repoFullName, {
                  head: t.branch,
                  base: proj.defaultBranch || 'main',
                  title: t.title,
                });
        }
        if (!prNumber) {
          this.logger.warn({ taskId: t.id }, 'Auto merge skipped: no branch or PR on the task');
          continue;
        }

        const merged = await this.githubApp.mergePullRequest(
          installationId,
          repoFullName,
          prNumber,
        );
        if (!merged) {
          this.logger.warn(
            { taskId: t.id, prNumber },
            'Auto merge refused by GitHub (conflict or rule) — left approved for the human',
          );
          continue;
        }
        await this.finalizeMerged(t.id, prNumber);
        this.logger.info({ taskId: t.id, prNumber }, 'Auto: merged (task done)');
      } catch (error) {
        // Best-effort by design: a failed auto step leaves the task where a
        // human can see and act on it; it must never fail the webhook job.
        this.logger.error({ taskId: t.id, err: error }, 'Auto progression failed');
      }
    }
  }

  private async finalizeMerged(taskId: string, prNumber: number): Promise<void> {
    await this.dbClient.db
      .update(task)
      .set({
        status: 'done',
        prState: 'merged',
        prNumber,
        prSyncedAt: new Date(),
        statusChangedAt: new Date(),
      })
      .where(and(eq(task.id, taskId), inArray(task.status, ['needs_review', 'approved'])));
  }
}
