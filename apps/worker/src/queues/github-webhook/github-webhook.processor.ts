import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  deployment,
  organization,
  project,
  projectEnvironment,
  task,
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from '@pkg/database';
import {
  classifyCiFailure,
  computeAutoDeployPaused,
  DeploymentProducer,
  GITHUB_WEBHOOK_QUEUE,
  GithubAppService,
  InjectLogger,
  PinoLogger,
  type CiClassification,
  type GithubWebhookJobPayload,
} from '@pkg/server';

interface ProjectRow {
  id: string;
  mode: string;
  defaultBranch: string;
  autoPausedAt: Date | null;
  createdBy: string;
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
    private readonly deployments: DeploymentProducer,
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
        createdBy: project.createdBy,
      })
      .from(project)
      .where(
        and(
          eq(project.orgId, org.id),
          // Archived projects are inert: no auto-progression, no circuit
          // breaker writes — events on their repos fall through.
          isNull(project.archivedAt),
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

    // The merge webhook is ALSO the deploy trigger: a merge into a project's
    // default branch redeploys its opted-in staging environments — matched
    // task or not (humans merge things without tickets too).
    if (event.prState === 'merged') {
      await this.autoDeploy(projects, event.baseBranch);
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

  /**
   * Merge-to-default-branch → redeploy every provisioned environment with
   * auto_deploy on. Two guards keep it boring:
   * - DEDUPE: an in-flight deployment absorbs the trigger — the running job
   *   resolves HEAD at build time, so intermediate merges collapse into the
   *   next run naturally.
   * - BREAKER: two consecutive failed auto-deploys pause the environment
   *   (computeAutoDeployPaused) until any deployment succeeds — the machine
   *   never loops on a red staging. Manual Deploy stays available throughout.
   * Attribution: the project creator — webhook events carry no specbook
   * session, and the creator is the accountable owner of the wiring.
   */
  private async autoDeploy(projects: ProjectRow[], baseBranch: string): Promise<void> {
    for (const p of projects) {
      if (baseBranch !== p.defaultBranch) continue;
      const environments = await this.dbClient.db
        .select()
        .from(projectEnvironment)
        .where(
          and(
            eq(projectEnvironment.projectId, p.id),
            eq(projectEnvironment.autoDeploy, true),
            eq(projectEnvironment.provisionStatus, 'provisioned'),
          ),
        );
      for (const env of environments) {
        const recent = await this.dbClient.db
          .select({ status: deployment.status, trigger: deployment.trigger })
          .from(deployment)
          .where(eq(deployment.environmentId, env.id))
          .orderBy(desc(deployment.createdAt))
          .limit(10);
        if (recent.some((d) => ['queued', 'building', 'deploying'].includes(d.status))) {
          this.logger.info(
            { environmentId: env.id },
            'Auto-deploy superseded: a deployment is already in flight',
          );
          continue;
        }
        if (computeAutoDeployPaused(recent)) {
          this.logger.warn(
            { environmentId: env.id },
            'Auto-deploy paused: two consecutive auto-deploys failed — deploy manually to reset',
          );
          continue;
        }
        const [created] = await this.dbClient.db
          .insert(deployment)
          .values({
            environmentId: env.id,
            sha: '',
            status: 'queued',
            trigger: 'auto',
            createdBy: p.createdBy,
          })
          .returning({ id: deployment.id });
        await this.deployments.enqueueDeploy(created!.id);
        this.logger.info(
          { environmentId: env.id, deploymentId: created!.id, projectId: p.id },
          'Auto-deploy enqueued for merged default branch',
        );
      }
    }
  }

  private async applyWorkflowRun(
    projects: ProjectRow[],
    event: Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }>,
  ): Promise<number> {
    // Why is the red red? Fetched and classified ONCE per event — both the
    // breaker and the task annotation read the same verdict. Null (plain
    // red) whenever nothing is positively recognized.
    const classification = event.ciState === 'failing' ? await this.classify(event) : null;

    // Circuit breaker: default-branch runs gate ALL auto progression for
    // their project. Red trips it (keeping the FIRST trip time), green
    // resets it. Feature-branch runs never touch it. A RETRYABLE red —
    // outage cancellations, lost runners — does not trip it: a flake on
    // main must not freeze the whole project's auto modes.
    for (const p of projects) {
      if (p.mode === 'manual' || event.headBranch !== p.defaultBranch) continue;
      if (event.ciState === 'failing' && classification?.kind === 'retryable') {
        this.logger.info(
          { projectId: p.id, pointer: classification.pointer },
          'Default branch red is retryable — breaker not tripped',
        );
      } else if (event.ciState === 'failing' && !p.autoPausedAt) {
        await this.dbClient.db
          .update(project)
          .set({
            autoPausedAt: new Date(),
            autoPauseKind: classification?.kind ?? null,
            autoPausePointer: classification?.pointer ?? null,
          })
          .where(and(eq(project.id, p.id), isNull(project.autoPausedAt)));
        p.autoPausedAt = new Date();
        this.logger.warn(
          { projectId: p.id, branch: event.headBranch, kind: classification?.kind ?? 'plain' },
          'Auto progression paused: default branch is red',
        );
      } else if (event.ciState === 'passing' && p.autoPausedAt) {
        await this.dbClient.db
          .update(project)
          .set({ autoPausedAt: null, autoPauseKind: null, autoPausePointer: null })
          .where(eq(project.id, p.id));
        p.autoPausedAt = null;
        this.logger.info({ projectId: p.id }, 'Auto progression resumed: default branch green');
        // Tasks that went green (or entered review) WHILE the breaker held
        // were skipped by every path — their own webhook already fired, and
        // the api's transition hook returned early on the pause. The reset
        // is the one moment that knows to re-scan them; without this they
        // sit in needs_review with passing CI forever.
        const parked = await this.dbClient.db
          .select({ id: task.id })
          .from(task)
          .where(
            and(
              eq(task.projectId, p.id),
              inArray(task.status, ['needs_review', 'approved']),
              eq(task.ciState, 'passing'),
            ),
          );
        if (parked.length > 0) {
          await this.autoProgress(
            [p],
            event.installationId,
            event.repoFullName,
            parked.map((t) => t.id),
          );
        }
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

    // A retryable red whose sha was already retried once ESCALATES to plain
    // red on the task: the retry is spent, the breaker and the human should
    // treat it as real. (Comparison happens per task below.)
    const rows = await this.dbClient.db
      .update(task)
      .set({
        ciState: event.ciState,
        prSyncedAt: new Date(),
        ciFailureKind: event.ciState === 'failing' ? (classification?.kind ?? null) : null,
      })
      .where(and(inArray(task.projectId, projectIds), match))
      .returning({ id: task.id, ciRetriedSha: task.ciRetriedSha });

    if (
      event.ciState === 'failing' &&
      classification?.kind === 'retryable' &&
      rows.length > 0 &&
      event.runId &&
      event.headSha &&
      this.githubApp.enabled
    ) {
      await this.maybeRetry(event, rows);
    }

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

  /** Jobs fetch + pure classification; degrades to null without runId or App. */
  private async classify(
    event: Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }>,
  ): Promise<CiClassification | null> {
    const jobs =
      event.runId && this.githubApp.enabled
        ? await this.githubApp.listWorkflowJobs(event.installationId, event.repoFullName, event.runId)
        : [];
    return classifyCiFailure({ runConclusion: event.runConclusion ?? 'failure', jobs });
  }

  /**
   * One automatic re-run of the failed jobs per head sha. The marker is
   * written BEFORE the rerun call: if the rerun then fails, the retry is
   * simply spent — the machine never loops on GitHub's answer. A sha whose
   * marker already exists escalates the task's kind to plain red instead.
   */
  private async maybeRetry(
    event: Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }>,
    rows: Array<{ id: string; ciRetriedSha: string | null }>,
  ): Promise<void> {
    const spent = rows.filter((r) => r.ciRetriedSha === event.headSha);
    if (spent.length > 0) {
      await this.dbClient.db
        .update(task)
        .set({ ciFailureKind: null })
        .where(
          inArray(
            task.id,
            spent.map((r) => r.id),
          ),
        );
      this.logger.warn(
        { taskIds: spent.map((r) => r.id), headSha: event.headSha },
        'Retryable red failed again after its one retry — escalated to plain red',
      );
      return;
    }

    await this.dbClient.db
      .update(task)
      .set({ ciRetriedSha: event.headSha })
      .where(
        inArray(
          task.id,
          rows.map((r) => r.id),
        ),
      );
    const rerun = await this.githubApp.rerunFailedJobs(
      event.installationId,
      event.repoFullName,
      event.runId!,
    );
    this.logger.info(
      { runId: event.runId, headSha: event.headSha, rerun },
      rerun
        ? 'Retryable red: failed jobs re-run once'
        : 'Retryable red: rerun refused by GitHub — retry spent, no loop',
    );
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
          // Human worker lane: a human task never auto-approves or auto-merges —
          // the owner reviews and the intern merges his own PR. Excluded here so
          // a late CI-green webhook can't sweep it through the auto engine.
          eq(task.isHumanTask, false),
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

        // The assumption-flag safety valve: a task shipped on a flagged
        // assumption is NEVER auto-merged, even in full-auto. Auto-review may
        // still run (the approve above), but the MERGE waits for a human who
        // reads the assumption and clears the flag. Additive hold only — it
        // leaves the task where the human can act on it and weakens no gate.
        if (t.assumptionFlag) {
          this.logger.info(
            { taskId: t.id },
            'Auto-merge held: task carries an assumption flag — routed to human review',
          );
          continue;
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
