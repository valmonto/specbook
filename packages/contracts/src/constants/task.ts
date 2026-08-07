/**
 * Task value sets and the status protocol — the single source, used by the
 * Zod schemas here, the varchar CHECK constraints in @pkg/database, and the
 * transition guard in the API. Zod-free: ships in frontend bundles.
 *
 * Only value arrays and maps live here; the TaskStatus/TaskCommentKind TYPES
 * are inferred by the schemas (and re-exported through types/), so exporting
 * them here too would collide in the client entry.
 */
export const TASK_STATUSES = [
  'draft',
  'ready',
  'in_progress',
  'blocked',
  'needs_review',
  'approved',
  'changes_requested',
  'done',
  'cancelled',
] as const;

// 'note' = a human steering instruction to the working agent: ordered,
// acked_at-stamped when the claimant reads it, and the needs_review gate
// refuses to ship past an unacked one.
export const TASK_COMMENT_KINDS = ['comment', 'progress', 'question', 'answer', 'note'] as const;

/**
 * Live GitHub state on a task, written only by the webhook worker — never by
 * users or agents. Null = no event ever arrived (the UI falls back to the
 * plain PR link).
 */
export const TASK_PR_STATES = ['open', 'merged', 'closed'] as const;
export const TASK_CI_STATES = ['pending', 'passing', 'failing'] as const;

/**
 * Why a red check is red, classified conservatively from run/job conclusions
 * (never job logs). Null = plain red: unknown causes are never guessed.
 * - retryable: flaky infrastructure (timeouts, lost runners, cancellations) —
 *   worth one automatic re-run, and the auto-mode breaker ignores it.
 * - setup: the workflow itself cannot run (file error, missing secret or
 *   permission) — retrying is pointless, a human owns the fix.
 * - external: an upstream service failed (action download, registry, rate
 *   limit) — patience, not code changes.
 */
export const CI_FAILURE_KINDS = ['retryable', 'setup', 'external'] as const;

export const TASK_AUTHOR_TYPES = ['user', 'agent'] as const;

type Status = (typeof TASK_STATUSES)[number];

/**
 * The status protocol: every status is either the human's move or the
 * agent's, and each actor may only perform its own transitions — the state
 * machine is what prevents an agent from approving its own work.
 *
 * Agent = a session authenticated with an MCP API key. It pulls from
 * `ready`, reports `blocked`/`needs_review`, and re-enters after answers
 * (`blocked`) or review feedback (`changes_requested`).
 */
export const AGENT_TASK_TRANSITIONS: Readonly<Partial<Record<Status, readonly Status[]>>> = {
  ready: ['in_progress'],
  in_progress: ['blocked', 'needs_review'],
  blocked: ['in_progress'],
  changes_requested: ['in_progress'],
};

/**
 * Human transitions. `in_progress → ready` is the stale-claim reset (a dead
 * session must not clog the queue forever); only the human accepts work
 * (`needs_review → approved`) or sends it back (`→ changes_requested`).
 *
 * `approved` is the merge queue: review passed, code not yet on main. The
 * PR-merge webhook performs approved → done (done = MERGED, a machine fact);
 * the human paths out of `approved` are the fallbacks — manual done for
 * repo-less tasks, back to needs_review to undo an approval, or
 * changes_requested when CI turns red after approval. `needs_review → done`
 * stays legal for tasks that have no PR to merge.
 */
export const HUMAN_TASK_TRANSITIONS: Readonly<Partial<Record<Status, readonly Status[]>>> = {
  draft: ['ready', 'cancelled'],
  ready: ['draft', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  needs_review: ['approved', 'done', 'changes_requested', 'cancelled'],
  approved: ['done', 'needs_review', 'changes_requested', 'cancelled'],
  changes_requested: ['ready', 'cancelled'],
};

/** Statuses that count as "the human's move" — the daily dashboard filter. */
export const HUMAN_COURT_STATUSES = ['blocked', 'needs_review', 'approved'] as const;

/** Terminal statuses: no transitions out, excluded from dependency blocking. */
export const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;

/**
 * Merge debt cap: when a project holds this many `approved` (merged-pending)
 * tasks, the agent queue (`list_tasks available`) stops returning its ready
 * tasks — enforced in the repository query, so no runner can bypass it.
 * Approving is cheap; letting unmerged branches pile up is how they go stale.
 */
export const MERGE_DEBT_CAP = 3;

/**
 * Project automation modes — the trust dial, per project:
 * - manual:     human reviews AND merges (the default protocol).
 * - auto_merge: human reviews; an approved task merges itself once CI passes.
 * - auto:       full auto — a reviewed submission (needs_review) approves and
 *               merges itself once CI passes. Requires CI signals: a project
 *               that never emits ciState events never auto-progresses, and a
 *               red default branch pauses all auto progression (circuit
 *               breaker) until it is green again.
 */
export const PROJECT_MODES = ['manual', 'auto_merge', 'auto'] as const;
