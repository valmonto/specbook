import type { WorkerOptions } from 'bullmq';

/**
 * GitHub webhook queue: the api verifies + normalizes deliveries and acks
 * fast; the worker does the task matching and writes. Serialized (concurrency
 * 1) so events for the same PR apply in arrival order.
 */
export const GITHUB_WEBHOOK_QUEUE = {
  name: 'github-webhook',
  workerOptions: {
    concurrency: 1,
    lockDuration: 60_000,
  } satisfies Partial<WorkerOptions>,
} as const;

export const GITHUB_WEBHOOK_JOB_NAMES = {
  PROCESS: 'process-event',
} as const;
