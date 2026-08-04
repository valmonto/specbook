/**
 * Lifecycle of one deployment run. 'healthy' means the stack answered its
 * health gate; 'failed' keeps the previous version serving.
 */
export const DEPLOYMENT_STATUSES = [
  'queued',
  'building',
  'deploying',
  'healthy',
  'failed',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Who started a deployment: a human click or the merge webhook. */
export const DEPLOYMENT_TRIGGERS = ['manual', 'auto'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/**
 * Fine-grained progress inside a run — the status stays the coarse state,
 * the phase says what the machine is doing RIGHT NOW (FUTURE.md §2).
 */
export const DEPLOYMENT_PHASES = ['resolve', 'build', 'transfer', 'render', 'up'] as const;
export type DeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];

/** Deployment logs keep the most recent bytes up to this cap. */
export const DEPLOYMENT_LOG_CAP_BYTES = 64 * 1024;
