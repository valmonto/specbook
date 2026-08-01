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
  or,
  sql,
} from '@pkg/database';
import {
  GITHUB_WEBHOOK_QUEUE,
  InjectLogger,
  PinoLogger,
  type GithubWebhookJobPayload,
} from '@pkg/server';

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
 */
@Processor(GITHUB_WEBHOOK_QUEUE.name, GITHUB_WEBHOOK_QUEUE.workerOptions)
export class GithubWebhookProcessor extends WorkerHost {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
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
    const projects = await this.dbClient.db
      .select({ id: project.id })
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
    const projectIds = projects.map((p) => p.id);

    const matched =
      event.kind === 'pull_request'
        ? await this.applyPullRequest(projectIds, event)
        : await this.applyWorkflowRun(projectIds, event);

    this.logger.info(
      { kind: event.kind, repo: event.repoFullName, matched, deliveryId: event.deliveryId },
      'GitHub event applied',
    );
    return { matched };
  }

  private async applyPullRequest(
    projectIds: string[],
    event: Extract<GithubWebhookJobPayload, { kind: 'pull_request' }>,
  ): Promise<number> {
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
    return rows.length;
  }

  private async applyWorkflowRun(
    projectIds: string[],
    event: Extract<GithubWebhookJobPayload, { kind: 'workflow_run' }>,
  ): Promise<number> {
    // Push-triggered runs on main (post-merge deploys) carry the base branch;
    // only annotate tasks that actually name this branch. PR numbers refine
    // the match when GitHub provides them.
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
    return rows.length;
  }
}
