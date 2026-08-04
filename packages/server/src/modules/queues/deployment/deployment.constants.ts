import type { WorkerOptions } from 'bullmq';

/**
 * Build+deploy runs: concurrency 1 ON PURPOSE — builds saturate small boxes,
 * and two deploys against one server must never interleave. Lock renewal is
 * automatic, so multi-minute builds don't stall the job.
 */
export const DEPLOYMENT_QUEUE = {
  name: 'deployment',
  workerOptions: {
    concurrency: 1,
    lockDuration: 120_000,
  } satisfies Partial<WorkerOptions>,
} as const;

export const DEPLOYMENT_JOB_NAMES = {
  DEPLOY: 'deploy-environment',
} as const;
