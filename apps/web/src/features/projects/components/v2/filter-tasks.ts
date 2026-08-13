import type { Task, TaskStatus } from '@pkg/contracts';

/**
 * The board's status/search filter — the pure core, kept out of the page so it
 * stays unit-testable without a browser. The board always groups by area (see
 * group-tasks.ts); this narrows the FULL task set first and grouping arranges
 * the survivors. The two are orthogonal and compose:
 * `groupTasksByArea(filterTasks(tasks, filter))`.
 *
 * Status filtering is the pipeline strip's job now: a single selected stage
 * (or none = all stages). The old multi-bucket "Show" chips are gone — the
 * strip already is the one status control, with the per-stage funnel counts.
 */

/**
 * The filter state. Both fields are optional — an absent field narrows
 * nothing:
 * - `stage` null/undefined ⇒ all stages (the default). A concrete status keeps
 *   only tasks in exactly that pipeline stage.
 * - `query` matches (case-insensitive substring) against the task title.
 */
export interface TaskFilter {
  stage?: TaskStatus | null;
  query?: string;
}

/**
 * Narrow `tasks` by selected stage and title search. Pure and order-preserving:
 * the page groups/sorts afterwards.
 */
export function filterTasks(tasks: Task[], { stage, query }: TaskFilter): Task[] {
  const q = query?.trim().toLowerCase() ?? '';
  return tasks.filter((task) => {
    if (stage && task.status !== stage) return false;
    if (q && !task.title.toLowerCase().includes(q)) return false;
    return true;
  });
}
