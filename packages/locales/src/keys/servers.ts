/**
 * Server registry translation keys
 */
export const servers = {
  title: 'servers.title',
  description: 'servers.description',
  add: 'servers.add',
  name: 'servers.name',
  host: 'servers.host',
  port: 'servers.port',
  sshUser: 'servers.sshUser',
  roles: 'servers.roles',
  role: {
    build: 'servers.role.build',
    app: 'servers.role.app',
    data: 'servers.role.data',
    runner: 'servers.role.runner',
  },
  status: {
    unverified: 'servers.status.unverified',
    reachable: 'servers.status.reachable',
    unreachable: 'servers.status.unreachable',
    fingerprint_mismatch: 'servers.status.fingerprint_mismatch',
  },
  test: 'servers.test',
  testQueued: 'servers.testQueued',
  remove: 'servers.remove',
  removeConfirmTitle: 'servers.removeConfirmTitle',
  removeConfirmBody: 'servers.removeConfirmBody',
  publicKeyTitle: 'servers.publicKeyTitle',
  publicKeyHint: 'servers.publicKeyHint',
  copyKey: 'servers.copyKey',
  copied: 'servers.copied',
  empty: 'servers.empty',
  lastChecked: 'servers.lastChecked',
  errors: {
    notFound: 'servers.errors.notFound',
    nameTaken: 'servers.errors.nameTaken',
  },
} as const;
