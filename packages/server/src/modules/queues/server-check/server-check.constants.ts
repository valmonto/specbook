import type { WorkerOptions } from 'bullmq';

/**
 * Server reachability checks: the api enqueues, the worker SSHes. Low
 * concurrency — checks are cheap but hold sockets; serialized enough that a
 * misbehaving host can't tie up the worker.
 */
export const SERVER_CHECK_QUEUE = {
  name: 'server-check',
  workerOptions: {
    concurrency: 2,
    lockDuration: 60_000,
  } satisfies Partial<WorkerOptions>,
} as const;

export const SERVER_CHECK_JOB_NAMES = {
  CHECK: 'check-server',
  SWEEP: 'sweep-all',
} as const;
