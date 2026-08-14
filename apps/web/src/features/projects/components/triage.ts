import type { Task } from '@pkg/contracts';

/** The lookback window for the morning triage digest: the last ~night. */
export const TRIAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The five triage categories, in the order the digest renders them. */
export type TriageBucket = 'assumed' | 'blocked' | 'needsReview' | 'changesRequested' | 'merged';

export type TriageBuckets = Record<TriageBucket, Task[]>;

const recency = (a: Task, b: Task) =>
  new Date(b.statusChangedAt ?? b.updatedAt).getTime() -
  new Date(a.statusChangedAt ?? a.updatedAt).getTime();

/**
 * The pure core of the morning triage digest: regroup a project's tasks into
 * the categories that answer "what did the unattended run leave in my court?".
 * Read-only — it never mutates a task, only sorts copies into buckets:
 *
 *   - assumed: carries a held assumption flag (#86), not terminal. Outranks the
 *     plain status so a flagged review is never buried among ordinary ones.
 *   - blocked / needsReview / changesRequested: the current waiting states.
 *   - merged: reached `done` within `windowMs` — the overnight landings.
 *
 * Each task lands in exactly one bucket. Rows come back newest-activity first.
 */
export function triageTasks(
  tasks: Task[],
  now: number = Date.now(),
  windowMs: number = TRIAGE_WINDOW_MS,
): TriageBuckets {
  const since = now - windowMs;
  const buckets: TriageBuckets = {
    assumed: [],
    blocked: [],
    needsReview: [],
    changesRequested: [],
    merged: [],
  };

  for (const task of tasks) {
    if (task.status === 'done') {
      const at = new Date(task.statusChangedAt ?? task.updatedAt).getTime();
      if (at >= since) buckets.merged.push(task);
      continue;
    }
    if (task.status === 'cancelled') continue;
    if (task.assumptionFlag) {
      buckets.assumed.push(task);
      continue;
    }
    if (task.status === 'needs_review') buckets.needsReview.push(task);
    else if (task.status === 'blocked') buckets.blocked.push(task);
    else if (task.status === 'changes_requested') buckets.changesRequested.push(task);
  }

  for (const key of Object.keys(buckets) as TriageBucket[]) buckets[key].sort(recency);
  return buckets;
}

/** Total tasks across all triage buckets — 0 means "nothing since last night". */
export function triageTotal(buckets: TriageBuckets): number {
  return (
    buckets.assumed.length +
    buckets.blocked.length +
    buckets.needsReview.length +
    buckets.changesRequested.length +
    buckets.merged.length
  );
}
