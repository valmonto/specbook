import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  filterTasks,
  isFilterActive,
  parseStatusFilter,
  serializeStatusFilter,
  STATUS_BUCKETS,
} from '@/features/projects/components/v2/filter-tasks';
import { groupTasksByArea } from '@/features/projects/components/v2/group-tasks';
import { makeTask } from './helpers';

/**
 * The standalone board filter's pure core, and its composition with the
 * grouping core. Browserless: filtering narrows the FULL set first, then
 * grouping arranges the survivors — the two must compose in both modes.
 */

describe('bucketOf', () => {
  it('maps draft, the terminal statuses, and the in-flight complement', () => {
    expect(bucketOf('draft')).toBe('draft');
    expect(bucketOf('done')).toBe('done');
    expect(bucketOf('cancelled')).toBe('cancelled');
    for (const s of ['ready', 'in_progress', 'blocked', 'needs_review', 'approved', 'changes_requested'] as const) {
      expect(bucketOf(s)).toBe('active');
    }
  });
});

describe('filterTasks', () => {
  const tasks = [
    makeTask({ id: 'd', status: 'draft', title: 'Draft login form' }),
    makeTask({ id: 'a', status: 'in_progress', title: 'Active billing run' }),
    makeTask({ id: 'r', status: 'needs_review', title: 'Review billing export' }),
    makeTask({ id: 'x', status: 'done', title: 'Done and dusted' }),
    makeTask({ id: 'c', status: 'cancelled', title: 'Cancelled cleanup' }),
  ];

  it('undefined statuses and empty query narrow nothing', () => {
    expect(filterTasks(tasks, {})).toHaveLength(5);
    expect(filterTasks(tasks, { statuses: undefined, query: '   ' })).toHaveLength(5);
  });

  it('keeps only tasks whose bucket is selected', () => {
    const activeOnly = filterTasks(tasks, { statuses: ['active'] });
    expect(activeOnly.map((t) => t.id)).toEqual(['a', 'r']);

    const noTerminal = filterTasks(tasks, { statuses: ['draft', 'active'] });
    expect(noTerminal.map((t) => t.id).sort()).toEqual(['a', 'd', 'r']);
  });

  it('an explicit empty status list honestly shows nothing', () => {
    expect(filterTasks(tasks, { statuses: [] })).toEqual([]);
  });

  it('matches the title case-insensitively as a substring', () => {
    expect(filterTasks(tasks, { query: 'BILLING' }).map((t) => t.id)).toEqual(['a', 'r']);
    expect(filterTasks(tasks, { query: 'nomatch' })).toEqual([]);
  });

  it('composes status and query — both must pass', () => {
    const out = filterTasks(tasks, { statuses: ['active'], query: 'export' });
    expect(out.map((t) => t.id)).toEqual(['r']);
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
    makeTask({ id: 'no-live', area: null, status: 'ready', title: 'Untagged ready' }),
  ];

  it('grouping the filtered set drops emptied area sections (Area mode)', () => {
    // Hide done + cancelled: Auth (only a cancelled task) disappears entirely.
    const groups = groupTasksByArea(filterTasks(tasks, { statuses: ['active'] }));
    const keys = groups.map(([key]) => key);
    expect(keys).not.toContain('Auth');
    expect(new Set(keys)).toEqual(new Set(['Billing', '']));
    // Billing section now reflects the filter — only the live task remains.
    const billing = groups.find(([key]) => key === 'Billing')?.[1] ?? [];
    expect(billing.map((t) => t.id)).toEqual(['b-live']);
  });

  it('the "No area" bucket still trails after filtering', () => {
    const groups = groupTasksByArea(filterTasks(tasks, { statuses: ['active'] }));
    expect(groups[groups.length - 1]?.[0]).toBe('');
  });

  it('empty-after-filter yields no groups', () => {
    expect(groupTasksByArea(filterTasks(tasks, { query: 'zzz' }))).toEqual([]);
  });

  it('per-status counts (Status mode) reflect the filter', () => {
    const survivors = filterTasks(tasks, { query: 'Billing' });
    const counts: Record<string, number> = {};
    for (const t of survivors) counts[t.status] = (counts[t.status] ?? 0) + 1;
    expect(counts).toEqual({ done: 1, in_progress: 1 });
  });
});

describe('URL round-trip', () => {
  it('absent param means show all (undefined)', () => {
    expect(parseStatusFilter(null)).toBeUndefined();
  });

  it('parses valid buckets and drops unknown tokens', () => {
    expect(parseStatusFilter('active,done')).toEqual(['active', 'done']);
    expect(parseStatusFilter('active,bogus')).toEqual(['active']);
    expect(parseStatusFilter('')).toEqual([]);
  });

  it('serializes "all selected" to null so the default drops the param', () => {
    expect(serializeStatusFilter(STATUS_BUCKETS)).toBeNull();
    expect(serializeStatusFilter(['done', 'active'])).toBe('active,done');
  });

  it('parse ∘ serialize is stable for a partial selection', () => {
    const selection = parseStatusFilter('active,done');
    const serialized = serializeStatusFilter(selection!);
    expect(parseStatusFilter(serialized)).toEqual(selection);
  });
});

describe('isFilterActive', () => {
  it('is false for the default and true once anything narrows', () => {
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ statuses: STATUS_BUCKETS })).toBe(false);
    expect(isFilterActive({ query: '  ' })).toBe(false);
    expect(isFilterActive({ statuses: ['active'] })).toBe(true);
    expect(isFilterActive({ query: 'x' })).toBe(true);
  });
});
