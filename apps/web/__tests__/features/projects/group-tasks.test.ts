import { describe, expect, it } from 'vitest';
import { groupTasksByArea } from '@/features/projects/components/v2/group-tasks';
import { makeTask } from './helpers';

/**
 * The pure grouping core behind the project board's default (Area) view.
 * Browserless: assert membership, area ordering, "No area" always last, and
 * newest-first rows within a group.
 */
describe('groupTasksByArea', () => {
  it('returns no groups for an empty list', () => {
    expect(groupTasksByArea([])).toEqual([]);
  });

  it('collects every task into its area and puts "No area" last', () => {
    const groups = groupTasksByArea([
      makeTask({ id: 'a1', area: 'Billing', title: 'Bill A' }),
      makeTask({ id: 'n1', area: null, title: 'Null one' }),
      makeTask({ id: 'a2', area: 'Auth', title: 'Auth A' }),
      makeTask({ id: 'n2', area: '   ', title: 'Blank one' }),
    ]);

    const keys = groups.map(([key]) => key);
    // Untagged bucket uses the '' key and is always the final group.
    expect(keys[keys.length - 1]).toBe('');
    expect(keys.filter((k) => k === '')).toHaveLength(1);
    expect(new Set(keys)).toEqual(new Set(['Billing', 'Auth', '']));

    // null-area and whitespace-only-area tasks share the single "No area" group.
    const noArea = groups.find(([key]) => key === '')?.[1] ?? [];
    expect(noArea.map((t) => t.id).sort()).toEqual(['n1', 'n2']);
  });

  it('orders named areas busiest first, then alphabetically', () => {
    const groups = groupTasksByArea([
      makeTask({ id: 'z', area: 'Zebra' }),
      makeTask({ id: 'b1', area: 'Billing' }),
      makeTask({ id: 'b2', area: 'Billing' }),
      makeTask({ id: 'a', area: 'Auth' }),
      makeTask({ id: 'n', area: null }),
    ]);

    // Billing (2) leads on count; Auth before Zebra alphabetically on the tie;
    // "No area" ('') always trails.
    expect(groups.map(([key]) => key)).toEqual(['Billing', 'Auth', 'Zebra', '']);
  });

  it('keeps rows within a group newest-first', () => {
    const groups = groupTasksByArea([
      makeTask({ id: 'old', area: 'Billing', statusChangedAt: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'new', area: 'Billing', statusChangedAt: '2026-08-01T00:00:00.000Z' }),
      makeTask({ id: 'mid', area: 'Billing', statusChangedAt: '2026-04-01T00:00:00.000Z' }),
    ]);

    expect(groups[0]?.[1].map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('omits the "No area" group entirely when every task is tagged', () => {
    const groups = groupTasksByArea([
      makeTask({ id: 'a', area: 'Auth' }),
      makeTask({ id: 'b', area: 'Billing' }),
    ]);

    expect(groups.map(([key]) => key)).toEqual(['Auth', 'Billing']);
  });
});
