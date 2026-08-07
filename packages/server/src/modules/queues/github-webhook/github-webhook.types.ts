/**
 * Normalized GitHub webhook events — the api controller reduces raw payloads
 * to exactly what task matching needs, so Redis never carries multi-kilobyte
 * GitHub payloads and the worker never parses GitHub's shapes.
 *
 * No userId/orgId here on purpose: these jobs are system-originated (GitHub,
 * not a session). Tenancy is resolved worker-side from installationId — the
 * value stored on exactly one organization.
 */
export type GithubWebhookJobPayload =
  | {
      kind: 'pull_request';
      /** GitHub delivery id — job idempotency key. */
      deliveryId: string;
      installationId: number;
      repoFullName: string;
      prNumber: number;
      prUrl: string;
      headBranch: string;
      /** The PR's target branch — auto-deploy fires only for the default branch. */
      baseBranch: string;
      prState: 'open' | 'merged' | 'closed';
    }
  | {
      kind: 'workflow_run';
      deliveryId: string;
      installationId: number;
      repoFullName: string;
      headBranch: string;
      ciState: 'pending' | 'passing' | 'failing';
      /** PR numbers GitHub associates with the run (may be empty). */
      prNumbers: number[];
      /** Run id — lets the worker fetch jobs and re-run failures. Optional:
       *  jobs enqueued before this field existed still process. */
      runId?: number;
      /** Head sha of the run — the one-retry-per-sha guard key. */
      headSha?: string;
      /** GitHub's raw run conclusion (failure, cancelled, startup_failure, …)
       *  — the classifier's run-level input. */
      runConclusion?: string;
    };
