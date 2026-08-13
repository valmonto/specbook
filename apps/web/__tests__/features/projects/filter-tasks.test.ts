import { describe, expect, it } from 'vitest';
import { filterTasks } from '@/features/projects/components/v2/filter-tasks';
import { groupTasksByArea } from '@/features/projects/components/v2/group-tasks';
import { makeTask } from './helpers';

/**
 * The board's status/search filter (pure core) and its composition with the
 * always-Area grouping. Browserless: filtering narrows the FULL set first, then
 * grouping arranges the survivors. Status filtering is a single selected stage
 * now (the pipeline strip), not the old multi-bucket "Show" chips.
 */

describe('filterTasks', () => {
  const tasks = [
    makeTask({ id: 'd', status: 'draft', title: 'Draft login form' }),
    makeTask({ id: 'a', status: 'in_progress', title: 'Active billing run' }),
    makeTask({ id: 'r', status: 'needs_review', title: 'Review billing export' }),
    makeTask({ id: 'x', status: 'done', title: 'Done and dusted' }),
    makeTask({ id: 'c', status: 'cancelled', title: 'Cancelled cleanup' }),
  ];

  it('no stage and empty query narrow nothing', () => {
    expect(filterTasks(tasks, {})).toHaveLength(5);
    expect(filterTasks(tasks, { stage: null, query: '   ' })).toHaveLength(5);
  });

  it('keeps only tasks in the selected stage', () => {
    expect(filterTasks(tasks, { stage: 'in_progress' }).map((t) => t.id)).toEqual(['a']);
    expect(filterTasks(tasks, { stage: 'done' }).map((t) => t.id)).toEqual(['x']);
    // A stage with no tasks honestly shows nothing.
    expect(filterTasks(tasks, { stage: 'approved' })).toEqual([]);
  });

  it('matches the title case-insensitively as a substring', () => {
    expect(filterTasks(tasks, { query: 'BILLING' }).map((t) => t.id)).toEqual(['a', 'r']);
    expect(filterTasks(tasks, { query: 'nomatch' })).toEqual([]);
  });

  it('composes stage and query — both must pass', () => {
    const out = filterTasks(tasks, { stage: 'needs_review', query: 'export' });
    expect(out.map((t) => t.id)).toEqual(['r']);
    // Same query, a stage it does not sit in → dropped.
    expect(filterTasks(tasks, { stage: 'in_progress', query: 'export' })).toEqual([]);
  });

  it('preserves input order (grouping sorts later)', () => {
    expect(filterTasks(tasks, {}).map((t) => t.id)).toEqual(['d', 'a', 'r', 'x', 'c']);
  });
});

describe('filter + group composition', () => {
  const tasks = [
    makeTask({ id: 'b-done', area: 'Billing', status: 'done', title: 'Billing done' }),
    makeTask({ id: 'b-live', area: 'Billing', status: 'in_progress', title: 'Billing live' }),
    makeTask({ id: 'auth-cancel', area: 'Auth', status: 'cancelled', title: 'Auth cancel' }),
    makeTask({ id: 'no-live', area: null, status: 'in_progress', title: 'Untagged live' }),
  ];

  it('grouping the stage-filtered set drops emptied area sections', () => {
    // Filter to in_progress: only Billing (b-live) and "No area" (no-live) have
    // one; Auth and the done Billing row disappear.
    const groups = groupTasksByArea(filterTasks(tasks, { stage: 'in_progress' }));
    const keys = groups.map(([key]) => key);
    expect(keys).not.toContain('Auth');
    expect(new Set(keys)).toEqual(new Set(['Billing', '']));
    const billing = groups.find(([key]) => key === 'Billing')?.[1] ?? [];
    expect(billing.map((t) => t.id)).toEqual(['b-live']);
  });

  it('the "No area" bucket still trails after filtering', () => {
    const groups = groupTasksByArea(filterTasks(tasks, { stage: 'in_progress' }));
    expect(groups[groups.length - 1]?.[0]).toBe('');
  });

  it('empty-after-filter yields no groups', () => {
    expect(groupTasksByArea(filterTasks(tasks, { query: 'zzz' }))).toEqual([]);
  });

  it('a section rollup reflects the search filter, not the full list', () => {
    // Search "Billing" survives both Billing rows; the strip funnel counts read
    // this survivor set.
    const survivors = filterTasks(tasks, { query: 'Billing' });
    const counts: Record<string, number> = {};
    for (const t of survivors) counts[t.status] = (counts[t.status] ?? 0) + 1;
    expect(counts).toEqual({ done: 1, in_progress: 1 });
  });
});
