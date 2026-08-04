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
