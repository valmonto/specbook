import type { WorkerOptions } from 'bullmq';

/**
 * Data-plane provisioning: the api enqueues, the worker SSHes and creates
 * the environment's database/redis. Concurrency 1 — provisioning mutates
 * shared state on a box; two runs against one server must never interleave.
 */
export const ENVIRONMENT_PROVISION_QUEUE = {
  name: 'environment-provision',
  workerOptions: {
    concurrency: 1,
    lockDuration: 180_000,
  } satisfies Partial<WorkerOptions>,
} as const;

export const ENVIRONMENT_PROVISION_JOB_NAMES = {
  PROVISION: 'provision-environment',
  DEPROVISION: 'deprovision-unit',
} as const;
