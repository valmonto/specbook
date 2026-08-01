/**
 * Organization management translation keys
 */
export const orgs = {
  // Labels
  organization: 'orgs.organization',
  organizations: 'orgs.organizations',

  // GitHub connection (org settings card + install callback page)
  github: {
    title: 'orgs.github.title',
    description: 'orgs.github.description',
    notConfigured: 'orgs.github.notConfigured',
    connect: 'orgs.github.connect',
    connectedAs: 'orgs.github.connectedAs',
    disconnect: 'orgs.github.disconnect',
    disconnectHint: 'orgs.github.disconnectHint',
    repositories: 'orgs.github.repositories',
    reposHint: 'orgs.github.reposHint',
    noRepos: 'orgs.github.noRepos',
    connecting: 'orgs.github.connecting',
    connectSuccess: 'orgs.github.connectSuccess',
    connectFailed: 'orgs.github.connectFailed',
    missingInstallationId: 'orgs.github.missingInstallationId',
    backToSettings: 'orgs.github.backToSettings',
    private: 'orgs.github.private',
    template: 'orgs.github.template',
    templateNone: 'orgs.github.templateNone',
    templateHint: 'orgs.github.templateHint',
    templateBadge: 'orgs.github.templateBadge',
    errors: {
      notConfigured: 'orgs.github.errors.notConfigured',
      installationNotFound: 'orgs.github.errors.installationNotFound',
      notConnected: 'orgs.github.errors.notConnected',
      templateNotInGrant: 'orgs.github.errors.templateNotInGrant',
      templateNotATemplate: 'orgs.github.errors.templateNotATemplate',
    },
  },

  // Errors
  errors: {
    notFound: 'orgs.errors.notFound',
    onlyOwnerCanUpdate: 'orgs.errors.onlyOwnerCanUpdate',
    cannotDeleteActiveOrg: 'orgs.errors.cannotDeleteActiveOrg',
    noAccess: 'orgs.errors.noAccess',
    noActiveOrg: 'orgs.errors.noActiveOrg',
    orgMismatch: 'orgs.errors.orgMismatch',
  },
} as const;
