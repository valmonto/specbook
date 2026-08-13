import type { Task } from '@pkg/contracts';

/**
 * Grouping the project board by feature area — the pure core, kept out of the
 * page so it can be unit-tested without a browser. The page renders whatever
 * shape these return; ordering and membership decisions live here.
 */

/** Newest first: most recent stage/area entry on top (same idiom everywhere). */
export const byRecency = (a: Task, b: Task) =>
  new Date(b.statusChangedAt ?? b.createdAt).getTime() -
  new Date(a.statusChangedAt ?? a.createdAt).getTime();

/**
 * One area section: its key ('' is the untagged "No area" bucket) and the
 * tasks under it, already newest-first.
 */
export type AreaGroup = readonly [area: string, tasks: Task[]];

/**
 * Group tasks under one section per `area`. Named areas come first (busiest
 * first, then alphabetical); the untagged "No area" group — any task whose
 * area is null, empty, or whitespace — always sits last. Rows within a group
 * keep the newest-first order. Pure: no React, no i18n, trivially testable.
 */
export function groupTasksByArea(tasks: Task[]): AreaGroup[] {
  const byArea = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.area?.trim() ?? '';
    const list = byArea.get(key) ?? [];
    list.push(task);
    byArea.set(key, list);
  }
  for (const list of byArea.values()) list.sort(byRecency);
  const named = [...byArea.entries()]
    .filter(([key]) => key !== '')
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const untagged = byArea.get('');
  return untagged ? [...named, ['', untagged] as const] : named;
}
