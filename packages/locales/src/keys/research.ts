/**
 * Research translation keys
 */
export const research = {
  title: 'research.title',
  description: 'research.description',

  launcher: {
    heading: 'research.launcher.heading',
    placeholder: 'research.launcher.placeholder',
    subhint: 'research.launcher.subhint',
    start: 'research.launcher.start',
  },

  recent: {
    title: 'research.recent.title',
    searchAll: 'research.recent.searchAll',
    updated: 'research.recent.updated',
    by: 'research.recent.by',
    tasksCut: 'research.recent.tasksCut',
    empty: 'research.recent.empty',
    emptyHint: 'research.recent.emptyHint',
  },

  search: {
    title: 'research.search.title',
    placeholder: 'research.search.placeholder',
    back: 'research.search.back',
    noResults: 'research.search.noResults',
    loadingMore: 'research.search.loadingMore',
    end: 'research.search.end',
  },

  status: {
    researching: 'research.status.researching',
    needs_review: 'research.status.needs_review',
    accepted: 'research.status.accepted',
  },

  detail: {
    back: 'research.detail.back',
    conversationTab: 'research.detail.conversationTab',
    documentTab: 'research.detail.documentTab',
    researching: 'research.detail.researching',
    notFound: 'research.detail.notFound',
  },

  message: {
    you: 'research.message.you',
    agent: 'research.message.agent',
    updatedDocument: 'research.message.updatedDocument',
  },

  composer: {
    placeholder: 'research.composer.placeholder',
    hint: 'research.composer.hint',
    send: 'research.composer.send',
    startTitle: 'research.composer.startTitle',
    startBody: 'research.composer.startBody',
  },

  document: {
    label: 'research.document.label',
    version: 'research.document.version',
    notStarted: 'research.document.notStarted',
    empty: 'research.document.empty',
    accept: 'research.document.accept',
    reopen: 'research.document.reopen',
    createTickets: 'research.document.createTickets',
    noProject: 'research.document.noProject',
    changeProject: 'research.document.changeProject',
  },

  cut: {
    title: 'research.cut.title',
    subtitle: 'research.cut.subtitle',
    targetProject: 'research.cut.targetProject',
    noProject: 'research.cut.noProject',
    add: 'research.cut.add',
    titlePlaceholder: 'research.cut.titlePlaceholder',
    contextPlaceholder: 'research.cut.contextPlaceholder',
    remove: 'research.cut.remove',
    selected: 'research.cut.selected',
    create: 'research.cut.create',
    selectTickets: 'research.cut.selectTickets',
    empty: 'research.cut.empty',
    fromChip: 'research.cut.fromChip',
    area: 'research.cut.area',
    areaPlaceholder: 'research.cut.areaPlaceholder',
    noArea: 'research.cut.noArea',
    applyAreaToAll: 'research.cut.applyAreaToAll',
    applyAreaToAllHint: 'research.cut.applyAreaToAllHint',
  },

  toasts: {
    accepted: 'research.toasts.accepted',
    reopened: 'research.toasts.reopened',
    ticketsCreated: 'research.toasts.ticketsCreated',
  },

  errors: {
    notFound: 'research.errors.notFound',
    notReviewable: 'research.errors.notReviewable',
    notAccepted: 'research.errors.notAccepted',
    reopenFeedbackRequired: 'research.errors.reopenFeedbackRequired',
    noTargetProject: 'research.errors.noTargetProject',
  },
} as const;
