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
  'changes_requested',
  'done',
  'cancelled',
] as const;

export const TASK_COMMENT_KINDS = ['comment', 'progress', 'question', 'answer'] as const;

/**
 * Live GitHub state on a task, written only by the webhook worker — never by
 * users or agents. Null = no event ever arrived (the UI falls back to the
 * plain PR link).
 */
export const TASK_PR_STATES = ['open', 'merged', 'closed'] as const;
export const TASK_CI_STATES = ['pending', 'passing', 'failing'] as const;

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
 * (`needs_review → done`) or sends it back (`→ changes_requested`).
 * Cancellation is allowed from any non-terminal state.
 */
export const HUMAN_TASK_TRANSITIONS: Readonly<Partial<Record<Status, readonly Status[]>>> = {
  draft: ['ready', 'cancelled'],
  ready: ['draft', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  needs_review: ['done', 'changes_requested', 'cancelled'],
  changes_requested: ['ready', 'cancelled'],
};

/** Statuses that count as "the human's move" — the daily dashboard filter. */
export const HUMAN_COURT_STATUSES = ['blocked', 'needs_review'] as const;

/** Terminal statuses: no transitions out, excluded from dependency blocking. */
export const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;
