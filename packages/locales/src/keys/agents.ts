/**
 * Agents (fleet presence + managed lifecycle) translation keys
 */
export const agents = {
  title: 'agents.title',
  workingOn: 'agents.workingOn',
  seen: 'agents.seen',
  neverSeen: 'agents.neverSeen',
  status: {
    working: 'agents.status.working',
    idle: 'agents.status.idle',
    offline: 'agents.status.offline',
    stopped: 'agents.status.stopped',
    starting: 'agents.status.starting',
    auth_needed: 'agents.status.auth_needed',
    error: 'agents.status.error',
  },

  // Managed lifecycle
  addManaged: 'agents.addManaged',
  addManagedDesc: 'agents.addManagedDesc',
  name: 'agents.name',
  server: 'agents.server',
  serverHint: 'agents.serverHint',
  start: 'agents.start',
  stop: 'agents.stop',
  showLog: 'agents.showLog',
  hideLog: 'agents.hideLog',
  logEmpty: 'agents.logEmpty',
  authNeededHint: 'agents.authNeededHint',
  attachHint: 'agents.attachHint',
  serverBusyWarning: 'agents.serverBusyWarning',
  confirmAdditional: 'agents.confirmAdditional',

  errors: {
    notFound: 'agents.errors.notFound',
    nameTaken: 'agents.errors.nameTaken',
    serverNotRunner: 'agents.errors.serverNotRunner',
    serverBusy: 'agents.errors.serverBusy',
    notManaged: 'agents.errors.notManaged',
  },
} as const;
