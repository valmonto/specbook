/**
 * Project environments translation keys
 */
export const environments = {
  title: 'environments.title',
  description: 'environments.description',
  empty: 'environments.empty',
  addEnvironment: 'environments.addEnvironment',
  editEnvironment: 'environments.editEnvironment',
  removeEnvironment: 'environments.removeEnvironment',
  name: 'environments.name',
  server: 'environments.server',
  serverHint: 'environments.serverHint',
  domain: 'environments.domain',
  deployPath: 'environments.deployPath',
  autoDeploy: 'environments.autoDeploy',
  autoDeployHint: 'environments.autoDeployHint',
  autoDeployOff: 'environments.autoDeployOff',
  autoDeployNeedsProvision: 'environments.autoDeployNeedsProvision',
  autoDeployPausedWarning: 'environments.autoDeployPausedWarning',
  removeConfirmTitle: 'environments.removeConfirmTitle',
  removeConfirmBody: 'environments.removeConfirmBody',

  // Deployments
  deployAction: 'environments.deployAction',
  deployedLine: 'environments.deployedLine',
  openStaging: 'environments.openStaging',
  deploymentStatus: {
    queued: 'environments.deploymentStatus.queued',
    building: 'environments.deploymentStatus.building',
    deploying: 'environments.deploymentStatus.deploying',
    healthy: 'environments.deploymentStatus.healthy',
    failed: 'environments.deploymentStatus.failed',
  },

  // Data-plane provisioning
  provisionAction: 'environments.provisionAction',
  reprovisionAction: 'environments.reprovisionAction',
  provisionStatus: {
    unprovisioned: 'environments.provisionStatus.unprovisioned',
    provisioning: 'environments.provisionStatus.provisioning',
    provisioned: 'environments.provisionStatus.provisioned',
    failed: 'environments.provisionStatus.failed',
  },

  // Env var editor
  platformEnvTitle: 'environments.platformEnvTitle',
  platformEnvHint: 'environments.platformEnvHint',
  platformEnvEmpty: 'environments.platformEnvEmpty',
  userEnvTitle: 'environments.userEnvTitle',
  userEnvHint: 'environments.userEnvHint',
  userEnvEmpty: 'environments.userEnvEmpty',
  varName: 'environments.varName',
  varValue: 'environments.varValue',
  varValueWriteOnly: 'environments.varValueWriteOnly',
  setVar: 'environments.setVar',
  replaceVar: 'environments.replaceVar',
  deleteVarConfirmTitle: 'environments.deleteVarConfirmTitle',
  deleteVarConfirmBody: 'environments.deleteVarConfirmBody',

  errors: {
    notFound: 'environments.errors.notFound',
    nameTaken: 'environments.errors.nameTaken',
    serverNotApp: 'environments.errors.serverNotApp',
    serverNotData: 'environments.errors.serverNotData',
    notProvisioned: 'environments.errors.notProvisioned',
    noBuildServer: 'environments.errors.noBuildServer',
    varNotFound: 'environments.errors.varNotFound',
  },
} as const;
