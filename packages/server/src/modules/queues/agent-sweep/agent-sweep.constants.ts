import type { WorkerOptions } from 'bullmq';

/**
 * Agent sweep — presence housekeeping: in_progress claims whose agent has
 * gone silent past the stale threshold return to ready. One repeatable job,
 * idempotent by construction.
 */
export const AGENT_SWEEP_QUEUE = {
  name: 'agent-sweep',
  workerOptions: {
    concurrency: 1,
    lockDuration: 60_000,
  } satisfies Partial<WorkerOptions>,
  repeatEveryMs: 5 * 60 * 1000,
  /** Claims handled per run — bounded so a backlog can't stall a tick. */
  batchSize: 50,
} as const;
