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
  removeConfirmTitle: 'environments.removeConfirmTitle',
  removeConfirmBody: 'environments.removeConfirmBody',

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
    varNotFound: 'environments.errors.varNotFound',
  },
} as const;
