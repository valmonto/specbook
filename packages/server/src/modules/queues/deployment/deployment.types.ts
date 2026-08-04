export interface DeploymentJobPayload {
  /** The deployment row to execute; everything else is loaded by the worker. */
  deploymentId: string;
}
