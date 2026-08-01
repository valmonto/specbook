/**
 * Projects & tasks translation keys
 */
export const tasks = {
  // Nav / headings
  projects: 'tasks.projects',
  tasks: 'tasks.tasks',
  projectsDescription: 'tasks.projectsDescription',

  // Project form
  newProject: 'tasks.newProject',
  editProject: 'tasks.editProject',
  projectName: 'tasks.projectName',
  contextDoc: 'tasks.contextDoc',
  contextDocHint: 'tasks.contextDocHint',
  repoUrl: 'tasks.repoUrl',
  repoPickerPlaceholder: 'tasks.repoPickerPlaceholder',
  repoManualUrl: 'tasks.repoManualUrl',
  repoFromInstallation: 'tasks.repoFromInstallation',
  defaultBranch: 'tasks.defaultBranch',
  workdir: 'tasks.workdir',
  workdirHint: 'tasks.workdirHint',
  noProjects: 'tasks.noProjects',
  noProjectsDesc: 'tasks.noProjectsDesc',
  taskCount: 'tasks.taskCount',

  // Task form
  newTask: 'tasks.newTask',
  taskTitle: 'tasks.taskTitle',
  taskContext: 'tasks.taskContext',
  taskContextHint: 'tasks.taskContextHint',
  outOfScope: 'tasks.outOfScope',
  acceptanceCriteria: 'tasks.acceptanceCriteria',
  criterionPlaceholder: 'tasks.criterionPlaceholder',
  addCriterion: 'tasks.addCriterion',
  priority: 'tasks.priority',
  importJson: 'tasks.importJson',
  importJsonHint: 'tasks.importJsonHint',
  importJsonApply: 'tasks.importJsonApply',
  importJsonInvalid: 'tasks.importJsonInvalid',
  noTasks: 'tasks.noTasks',
  noTasksDesc: 'tasks.noTasksDesc',

  // Your-move dashboard
  dashboard: {
    title: 'tasks.dashboard.title',
    description: 'tasks.dashboard.description',
    empty: 'tasks.dashboard.empty',
    emptyDesc: 'tasks.dashboard.emptyDesc',
    inFlight: 'tasks.dashboard.inFlight',
    stale: 'tasks.dashboard.stale',
    queue: 'tasks.dashboard.queue',
    readyForAgents: 'tasks.dashboard.readyForAgents',
    draftsWaiting: 'tasks.dashboard.draftsWaiting',
    agentsIdle: 'tasks.dashboard.agentsIdle',
    waiting: 'tasks.dashboard.waiting',
  },

  // Statuses
  status: {
    draft: 'tasks.status.draft',
    ready: 'tasks.status.ready',
    in_progress: 'tasks.status.in_progress',
    blocked: 'tasks.status.blocked',
    needs_review: 'tasks.status.needs_review',
    changes_requested: 'tasks.status.changes_requested',
    done: 'tasks.status.done',
    cancelled: 'tasks.status.cancelled',
  },

  // Transitions (human court)
  actions: {
    markReady: 'tasks.actions.markReady',
    backToDraft: 'tasks.actions.backToDraft',
    resetClaim: 'tasks.actions.resetClaim',
    requeue: 'tasks.actions.requeue',
    resume: 'tasks.actions.resume',
    approve: 'tasks.actions.approve',
    requestChanges: 'tasks.actions.requestChanges',
    cancelTask: 'tasks.actions.cancelTask',
    deleteDraft: 'tasks.actions.deleteDraft',
    feedbackPlaceholder: 'tasks.actions.feedbackPlaceholder',
    answerPlaceholder: 'tasks.actions.answerPlaceholder',
    confirm: 'tasks.actions.confirm',
  },

  // Detail
  detail: {
    claimedBy: 'tasks.detail.claimedBy',
    claimedAgo: 'tasks.detail.claimedAgo',
    branch: 'tasks.detail.branch',
    prUrl: 'tasks.detail.prUrl',
    openPr: 'tasks.detail.openPr',
    comments: 'tasks.detail.comments',
    noComments: 'tasks.detail.noComments',
    commentPlaceholder: 'tasks.detail.commentPlaceholder',
    addComment: 'tasks.detail.addComment',
    dependencies: 'tasks.detail.dependencies',
    dependents: 'tasks.detail.dependents',
    addDependency: 'tasks.detail.addDependency',
    agent: 'tasks.detail.agent',
    you: 'tasks.detail.you',
    kind: {
      comment: 'tasks.detail.kind.comment',
      progress: 'tasks.detail.kind.progress',
      question: 'tasks.detail.kind.question',
      answer: 'tasks.detail.kind.answer',
    },
  },

  // Errors
  errors: {
    repoNotInGrant: 'tasks.errors.repoNotInGrant',
    projectNotFound: 'tasks.errors.projectNotFound',
    notFound: 'tasks.errors.notFound',
    invalidTransition: 'tasks.errors.invalidTransition',
    dispatchGate: 'tasks.errors.dispatchGate',
    reviewGate: 'tasks.errors.reviewGate',
    questionRequired: 'tasks.errors.questionRequired',
    feedbackRequired: 'tasks.errors.feedbackRequired',
    alreadyClaimed: 'tasks.errors.alreadyClaimed',
    statusConflict: 'tasks.errors.statusConflict',
    terminalTask: 'tasks.errors.terminalTask',
    onlyDraftDeletable: 'tasks.errors.onlyDraftDeletable',
    criterionNotFound: 'tasks.errors.criterionNotFound',
    dependencyNotFound: 'tasks.errors.dependencyNotFound',
    dependencySameProject: 'tasks.errors.dependencySameProject',
    dependencyCycle: 'tasks.errors.dependencyCycle',
  },
} as const;
