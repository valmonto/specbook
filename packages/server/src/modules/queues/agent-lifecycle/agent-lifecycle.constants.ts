import type { WorkerOptions } from 'bullmq';

/** Managed-agent lifecycle: start/stop jobs, one box touched at a time. */
export const AGENT_LIFECYCLE_QUEUE = {
  name: 'agent-lifecycle',
  workerOptions: {
    concurrency: 1,
    lockDuration: 180_000,
  } satisfies Partial<WorkerOptions>,
} as const;
