import { vi } from 'vitest';
import type { Task } from '@pkg/contracts';

/** A fully-shaped task; override per test. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    title: 'Fixture task',
    context: 'Some context',
    outOfScope: null,
    acceptanceCriteria: [],
    status: 'draft',
    priority: 0,
    claimedBy: null,
    claimedAt: null,
    branch: null,
    prUrl: null,
    prState: null,
    prNumber: null,
    ciState: null,
    ciFailureKind: null,
    prSyncedAt: null,
    statusChangedBy: null,
    statusChangedAt: '2026-08-02T10:00:00.000Z',
    createdBy: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

type ActionResult = { e: Error | null; d: unknown };
type ExecuteMock = ReturnType<typeof vi.fn<(dto: unknown) => Promise<ActionResult>>>;

/** An action-hook shape (`useTransitionTask` and friends). */
export function makeAction(
  execute: ExecuteMock = vi.fn<(dto: unknown) => Promise<ActionResult>>(async () => ({
    e: null,
    d: null,
  })),
): { execute: ExecuteMock; isLoading: boolean; error: Error | null; reset: () => void } {
  return { execute, isLoading: false, error: null, reset: vi.fn() };
}

/** A resolvable-later promise, for observing optimistic UI mid-flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Radix pointer/scroll APIs missing from jsdom. */
export function installRadixDomShims() {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}
