/**
 * The redeploy breaker, shared by the worker (skip decision) and the api
 * (surface the pause in the UI): two consecutive AUTO deployments failing
 * stops further auto-deploys until any deployment succeeds. Manual failures
 * neither count nor reset — the machine only judges its own attempts, and
 * only a success clears the slate.
 */
export interface DeploymentVerdict {
  status: string;
  trigger: string;
}

/** `deployments` newest-first. */
export function computeAutoDeployPaused(deployments: DeploymentVerdict[]): boolean {
  let consecutiveAutoFailures = 0;
  for (const d of deployments) {
    if (d.status === 'healthy') return false; // any success resets
    if (['queued', 'building', 'deploying'].includes(d.status)) {
      // Something is running — its outcome will decide; don't call it paused.
      return false;
    }
    if (d.status === 'failed' && d.trigger === 'auto') {
      consecutiveAutoFailures += 1;
      if (consecutiveAutoFailures >= 2) return true;
    }
    // Manual failures fall through: they neither count nor reset.
  }
  return false;
}
