import type { GithubWebhookJobPayload } from '@pkg/server';

/**
 * Reduces a raw GitHub delivery to the compact job the worker consumes.
 * Pure and defensive: anything unexpected — unknown event, missing fields,
 * fork weirdness — returns null and the delivery is acked and dropped, never
 * 5xxed (GitHub retries 5xxes; there is nothing to retry here).
 */
export function normalizeGithubEvent(
  event: string,
  body: unknown,
  deliveryId: string,
): GithubWebhookJobPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, any>;

  const installationId = payload.installation?.id;
  const repoFullName = payload.repository?.full_name;
  if (typeof installationId !== 'number' || typeof repoFullName !== 'string') return null;

  if (event === 'pull_request') {
    const pr = payload.pull_request;
    if (typeof pr?.number !== 'number' || typeof pr?.head?.ref !== 'string') return null;

    // Every pull_request action carries the full PR object, so state is
    // derived from the object, not the action — a `labeled` event refreshes
    // state just as well as `closed`.
    const prState: 'open' | 'merged' | 'closed' =
      pr.state === 'open' ? 'open' : pr.merged === true ? 'merged' : 'closed';

    return {
      kind: 'pull_request',
      deliveryId,
      installationId,
      repoFullName,
      prNumber: pr.number,
      prUrl: typeof pr.html_url === 'string' ? pr.html_url : '',
      headBranch: pr.head.ref,
      baseBranch: typeof pr.base?.ref === 'string' ? pr.base.ref : '',
      prState,
    };
  }

  if (event === 'workflow_run') {
    const run = payload.workflow_run;
    if (typeof run?.head_branch !== 'string') return null;

    // action_required / cancelled / skipped / neutral read as "not a
    // verdict" — only a completed run with a hard failure marks failing.
    const ciState: 'pending' | 'passing' | 'failing' =
      run.status !== 'completed'
        ? 'pending'
        : run.conclusion === 'success'
          ? 'passing'
          : ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)
            ? 'failing'
            : 'pending';

    const prNumbers = Array.isArray(run.pull_requests)
      ? run.pull_requests
          .map((pr: unknown) => (pr as { number?: unknown })?.number)
          .filter((n: unknown): n is number => typeof n === 'number')
      : [];

    return {
      kind: 'workflow_run',
      deliveryId,
      installationId,
      repoFullName,
      headBranch: run.head_branch,
      ciState,
      prNumbers,
    };
  }

  return null;
}
