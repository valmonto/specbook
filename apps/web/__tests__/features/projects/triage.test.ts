import { describe, expect, it } from 'vitest';
import { triageTasks, triageTotal, TRIAGE_WINDOW_MS } from '@/features/projects/components/triage';
import { makeTask } from './helpers';

/**
 * The pure core of the morning triage digest. Browserless: assert every task
 * lands in exactly one bucket, that the assumption flag outranks the plain
 * status, that `merged` respects the lookback window, and that terminal noise
 * (cancelled / old done) is excluded.
 */
describe('triageTasks', () => {
  const NOW = new Date('2026-08-14T12:00:00.000Z').getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  it('returns empty buckets for an empty list', () => {
    const b = triageTasks([], NOW);
    expect(triageTotal(b)).toBe(0);
  });

  it('sorts each status into its waiting bucket', () => {
    const b = triageTasks(
      [
        makeTask({ id: 'r', status: 'needs_review' }),
        makeTask({ id: 'x', status: 'blocked' }),
        makeTask({ id: 'c', status: 'changes_requested' }),
      ],
      NOW,
    );
    expect(b.needsReview.map((t) => t.id)).toEqual(['r']);
    expect(b.blocked.map((t) => t.id)).toEqual(['x']);
    expect(b.changesRequested.map((t) => t.id)).toEqual(['c']);
    expect(b.assumed).toHaveLength(0);
    expect(b.merged).toHaveLength(0);
  });

  it('routes a flagged, held task to "assumed" — not its plain status bucket', () => {
    const flag = { what: 'Used snake_case', why: 'matches table', howToVerify: 'check schema' };
    const b = triageTasks(
      [
        makeTask({ id: 'flagged', status: 'needs_review', assumptionFlag: flag }),
        makeTask({ id: 'plain', status: 'needs_review' }),
      ],
      NOW,
    );
    expect(b.assumed.map((t) => t.id)).toEqual(['flagged']);
    expect(b.needsReview.map((t) => t.id)).toEqual(['plain']);
  });

  it('includes done tasks merged within the window, excludes older ones', () => {
    const b = triageTasks(
      [
        makeTask({ id: 'fresh', status: 'done', statusChangedAt: iso(NOW - 3 * 60 * 60 * 1000) }),
        makeTask({
          id: 'stale',
          status: 'done',
          statusChangedAt: iso(NOW - TRIAGE_WINDOW_MS - 1000),
        }),
      ],
      NOW,
    );
    expect(b.merged.map((t) => t.id)).toEqual(['fresh']);
  });

  it('excludes cancelled tasks entirely', () => {
    const b = triageTasks([makeTask({ id: 'z', status: 'cancelled' })], NOW);
    expect(triageTotal(b)).toBe(0);
  });

  it('orders rows within a bucket newest-activity first', () => {
    const b = triageTasks(
      [
        makeTask({ id: 'old', status: 'blocked', statusChangedAt: iso(NOW - 10 * 60 * 60 * 1000) }),
        makeTask({ id: 'new', status: 'blocked', statusChangedAt: iso(NOW - 1 * 60 * 60 * 1000) }),
      ],
      NOW,
    );
    expect(b.blocked.map((t) => t.id)).toEqual(['new', 'old']);
  });
});
