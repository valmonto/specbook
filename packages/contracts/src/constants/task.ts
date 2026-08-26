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
 *
 * `done → changes_requested` is the reopen: manual testing after the merge
 * found residuals, and the feedback comment (required, like a review
 * rejection) is the round-2 spec delta. Human-only — done stays terminal
 * for agents, so nothing can resurrect its own shipped work.
 *
 * `draft → done` is the stranded-work recovery path: a task whose PR merged
 * out-of-band (so it never travelled ready → needs_review → approved) would
 * otherwise have no route to `done` — the review gate needs an OPEN PR, and
 * from `ready` a human can only cancel or return to draft. This human-only
 * edge lets the owner record the truth (it shipped) directly. It is absent
 * from AGENT_TASK_TRANSITIONS on purpose: agents stay barred from `done`.
 */
export const HUMAN_TASK_TRANSITIONS: Readonly<Partial<Record<Status, readonly Status[]>>> = {
  draft: ['ready', 'done', 'cancelled'],
  ready: ['draft', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  needs_review: ['approved', 'done', 'changes_requested', 'cancelled'],
  approved: ['done', 'needs_review', 'changes_requested', 'cancelled'],
  changes_requested: ['ready', 'cancelled'],
  done: ['changes_requested'],
};

/**
 * Assignee transitions: a human worker (an intern) assigned a `isHumanTask`
 * task is an EXECUTOR on the board, exactly like an agent — they claim ready
 * work, push a branch + PR, and submit for the owner's review. So their legal
 * moves mirror {@link AGENT_TASK_TRANSITIONS}, NOT the owner's court moves:
 * they can start work and request review, but never approve, promote to ready,
 * or merge (those stay the owner's, gated by {@link HUMAN_TASK_TRANSITIONS} +
 * the permission layer). The service selects this map when the acting user is
 * the task's assignee; every other human uses HUMAN_TASK_TRANSITIONS.
 */
export const ASSIGNEE_TASK_TRANSITIONS: Readonly<Partial<Record<Status, readonly Status[]>>> = {
  ready: ['in_progress'],
  in_progress: ['blocked', 'needs_review'],
  blocked: ['in_progress'],
  changes_requested: ['in_progress'],
};

/** Statuses that count as "the human's move" — the daily dashboard filter. */
export const HUMAN_COURT_STATUSES = ['blocked', 'needs_review', 'approved'] as const;

/** Terminal statuses: no transitions out. A terminal task is never a live
 *  dependent, so cancelling a prerequisite leaves its terminal dependents
 *  untouched (their history stays intact) — see DEPENDENCY_SATISFYING_STATUSES
 *  for how a *non*-terminal dependent is handled. */
export const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;

/**
 * Dependency statuses that SATISFY a prerequisite — a dependent may enter the
 * agent queue only once every prerequisite it waits on is in this set. `done`
 * = the prerequisite shipped, which is the only thing that satisfies.
 *
 * `cancelled` is deliberately NOT here: a killed prerequisite never delivered
 * anything, so treating it as satisfied is a foot-gun (a dependent would sail
 * into the queue as if its groundwork were done). The cancel path DETACHES the
 * edge from every non-terminal dependent, so in normal operation no active
 * task is left depending on a cancelled one; this set is the belt to that
 * suspenders — should an edge linger (e.g. a `done → changes_requested` reopen
 * that predates the detach), the dependent BLOCKS rather than silently
 * proceeding. Single source: the queue predicate in @pkg/api reads from here.
 */
export const DEPENDENCY_SATISFYING_STATUSES = ['done'] as const;

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
