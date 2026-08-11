import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { GetResearchResponse } from '@pkg/contracts';
import { useRecentResearch, useResearch } from '@/features/research/hooks/use-research';

/**
 * Poll-while-researching, asserted at the module seam: we mock
 * `useCachedRequest` and inspect the SWR `refreshInterval` the hook wires in.
 * No real timers, so no flakiness — we only prove the gate is a function of the
 * live status (positive while `researching`, 0 once it settles).
 */

const useCachedRequest = vi.hoisted(() => vi.fn(() => ({ data: null, isLoading: false })));

vi.mock('@/shared/hooks/use-cached-request', () => ({ useCachedRequest }));
vi.mock('@/shared/auth/auth-context', () => ({ useAuth: () => ({ user: { orgId: 'o1' } }) }));
vi.mock('@/shared/hooks/use-permissions', () => ({ useCan: () => true }));

function makeResearch(overrides: Partial<GetResearchResponse> = {}): GetResearchResponse {
  return {
    id: 'r1',
    orgId: 'o1',
    projectId: null,
    title: 'x',
    status: 'needs_review',
    bodyMarkdown: null,
    version: 0,
    createdBy: 'u',
    acceptedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    messages: [],
    tasksCut: 0,
    ...overrides,
  };
}

/** Pull the last `config.refreshInterval` handed to the mocked useCachedRequest. */
function lastRefreshInterval() {
  const args = useCachedRequest.mock.calls.at(-1) as unknown[] | undefined;
  const call = args?.[0] as { config?: { refreshInterval?: unknown } } | undefined;
  return call?.config?.refreshInterval;
}

beforeEach(() => useCachedRequest.mockClear());

describe('useResearch polling gate', () => {
  it('polls while a turn is in flight and stops once the document settles', () => {
    renderHook(() => useResearch('r1'));
    const refreshInterval = lastRefreshInterval() as (d: GetResearchResponse) => number;

    expect(typeof refreshInterval).toBe('function');
    // Positive while researching…
    expect(refreshInterval(makeResearch({ status: 'researching' }))).toBeGreaterThan(0);
    // …and off in every settled state.
    expect(refreshInterval(makeResearch({ status: 'needs_review' }))).toBe(0);
    expect(refreshInterval(makeResearch({ status: 'accepted' }))).toBe(0);
  });
});

describe('useRecentResearch polling', () => {
  it('revalidates the recent list on a modest, non-hammering interval', () => {
    renderHook(() => useRecentResearch());
    const refreshInterval = lastRefreshInterval();

    expect(typeof refreshInterval).toBe('number');
    expect(refreshInterval as number).toBeGreaterThan(0);
    // Modest — an order of magnitude slower than the in-flight document poll.
    expect(refreshInterval as number).toBeGreaterThanOrEqual(10000);
  });
});
