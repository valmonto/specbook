import { TERMINAL_TASK_STATUSES, type Task, type TaskStatus } from '@pkg/contracts';

/**
 * The board's standalone filter — the pure core, kept out of the page so the
 * filter and its composition with grouping are unit-testable without a
 * browser. Filtering narrows the FULL task set; whatever grouping the page is
 * in (see group-tasks.ts) then arranges the survivors. The two are orthogonal
 * and compose: `groupTasksByArea(filterTasks(tasks, filter))`.
 */

/**
 * Status buckets for the filter — the coarse groupings the rest of the app
 * already uses, not a new taxonomy:
 * - `done` and `cancelled` are the two TERMINAL_TASK_STATUSES, each its own
 *   bucket (they are what floods the board and the filter exists to hide).
 * - `draft` is the pre-ready holding stage, kept separate from live work.
 * - `active` is everything in flight — the complement: ready, in_progress,
 *   blocked, needs_review, approved, changes_requested.
 */
export const STATUS_BUCKETS = ['draft', 'active', 'done', 'cancelled'] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** Which bucket a status falls in. Grounded in TERMINAL_TASK_STATUSES. */
export function bucketOf(status: TaskStatus): StatusBucket {
  if (status === 'draft') return 'draft';
  if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) return status as StatusBucket;
  return 'active';
}

/**
 * The filter state. Both fields are optional — an absent field narrows
 * nothing:
 * - `statuses` undefined ⇒ every bucket visible (the safe default). An
 *   explicit (possibly empty) list keeps only tasks whose bucket is in it; an
 *   empty list honestly shows nothing.
 * - `query` matches (case-insensitive substring) against the task title.
 */
export interface TaskFilter {
  statuses?: readonly StatusBucket[];
  query?: string;
}

/** True when this filter would narrow the set at all (drives the UI reset). */
export function isFilterActive({ statuses, query }: TaskFilter): boolean {
  const narrowsStatus = statuses !== undefined && statuses.length !== STATUS_BUCKETS.length;
  return narrowsStatus || Boolean(query?.trim());
}

/**
 * Narrow `tasks` by status bucket and title search. Pure and order-preserving:
 * the page sorts/groups afterwards.
 */
export function filterTasks(tasks: Task[], { statuses, query }: TaskFilter): Task[] {
  const q = query?.trim().toLowerCase() ?? '';
  return tasks.filter((task) => {
    if (statuses !== undefined && !statuses.includes(bucketOf(task.status))) return false;
    if (q && !task.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * Read the `?status=` param into a bucket list. Absent ⇒ undefined (show all);
 * present ⇒ the valid buckets it names (unknown tokens dropped, so a stale
 * link degrades gracefully rather than hiding everything).
 */
export function parseStatusFilter(param: string | null): StatusBucket[] | undefined {
  if (param === null) return undefined;
  return param
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is StatusBucket => (STATUS_BUCKETS as readonly string[]).includes(s));
}

/**
 * Serialize a bucket selection back to a `?status=` value. "All selected" is
 * the default, so it returns null (drop the param) — shareable URLs stay
 * clean and the default round-trips to undefined.
 */
export function serializeStatusFilter(buckets: readonly StatusBucket[]): string | null {
  const uniqueInOrder = STATUS_BUCKETS.filter((b) => buckets.includes(b));
  if (uniqueInOrder.length === STATUS_BUCKETS.length) return null;
  return uniqueInOrder.join(',');
}
