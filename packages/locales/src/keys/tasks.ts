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
  repository: 'tasks.repository',
  repoPickerPlaceholder: 'tasks.repoPickerPlaceholder',
  repoManualUrl: 'tasks.repoManualUrl',
  repoFromInstallation: 'tasks.repoFromInstallation',
  repoCreateNew: 'tasks.repoCreateNew',
  repoNewName: 'tasks.repoNewName',
  repoFromTemplate: 'tasks.repoFromTemplate',
  repoCreateHint: 'tasks.repoCreateHint',
  repoGrantAccess: 'tasks.repoGrantAccess',
  repoGrantRecheck: 'tasks.repoGrantRecheck',
  repoGrantStillMissing: 'tasks.repoGrantStillMissing',
  defaultBranch: 'tasks.defaultBranch',
  workdir: 'tasks.workdir',
  workdirHint: 'tasks.workdirHint',
  noProjects: 'tasks.noProjects',
  noProjectsDesc: 'tasks.noProjectsDesc',
  taskCount: 'tasks.taskCount',

  // Project archive
  archiveProject: 'tasks.archiveProject',
  unarchiveProject: 'tasks.unarchiveProject',
  archivedProjects: 'tasks.archivedProjects',
  archiveConfirmTitle: 'tasks.archiveConfirmTitle',
  archiveConfirmBody: 'tasks.archiveConfirmBody',
  archivedBanner: 'tasks.archivedBanner',
  unarchiveConfirmTitle: 'tasks.unarchiveConfirmTitle',
  unarchiveConfirmBody: 'tasks.unarchiveConfirmBody',
  deleteProject: 'tasks.deleteProject',
  deleteConfirmTitle: 'tasks.deleteConfirmTitle',
  deleteConfirmBody: 'tasks.deleteConfirmBody',

  // Task form
  newTask: 'tasks.newTask',
  // Create-with-dependency: the split-button menu + its dialog.
  newTaskWith: {
    menu: 'tasks.newTaskWith.menu',
    title: 'tasks.newTaskWith.title',
    description: 'tasks.newTaskWith.description',
    titleLabel: 'tasks.newTaskWith.titleLabel',
    create: 'tasks.newTaskWith.create',
  },
  taskTitle: 'tasks.taskTitle',
  taskContext: 'tasks.taskContext',
  taskContextHint: 'tasks.taskContextHint',
  outOfScope: 'tasks.outOfScope',
  // Free-text feature/flow label for the always-Area board.
  area: 'tasks.area',
  areaPlaceholder: 'tasks.areaPlaceholder',
  noArea: 'tasks.noArea',
  // The board's title search — orthogonal to the pipeline strip's status
  // filter (the strip is the one status control; see PipelineStrip).
  filter: {
    searchPlaceholder: 'tasks.filter.searchPlaceholder',
    searchLabel: 'tasks.filter.searchLabel',
  },
  acceptanceCriteria: 'tasks.acceptanceCriteria',
  criterionPlaceholder: 'tasks.criterionPlaceholder',
  addCriterion: 'tasks.addCriterion',
  priority: 'tasks.priority',
  // Human-only work: excluded from the agent queue, chip on the board.
  humanTask: 'tasks.humanTask',
  humanTaskToggle: 'tasks.humanTaskToggle',

  // Assumption flag: a reversible judgment call the agent shipped on instead of
  // hard-blocking. Chip on the board row; full record + Clear in the detail.
  assumption: {
    chip: 'tasks.assumption.chip',
    heading: 'tasks.assumption.heading',
    what: 'tasks.assumption.what',
    why: 'tasks.assumption.why',
    howToVerify: 'tasks.assumption.howToVerify',
    clear: 'tasks.assumption.clear',
  },

  // Agent-reported cost (task detail line).
  cost: {
    label: 'tasks.cost.label',
    tokens: 'tasks.cost.tokens',
  },
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
    // One-line "your move" hints on review/approved rows.
    yourMoveReview: 'tasks.dashboard.yourMoveReview',
    yourMoveMergeGreen: 'tasks.dashboard.yourMoveMergeGreen',
    yourMoveMergeRed: 'tasks.dashboard.yourMoveMergeRed',
    pausedBudget: 'tasks.dashboard.pausedBudget',
  },

  // Morning triage digest: per-project, read-only roll-up of what an
  // unattended (overnight) run left in the human's court — one glance.
  triage: {
    title: 'tasks.triage.title',
    window24h: 'tasks.triage.window24h',
    // Summary chips in the panel header (count-bearing).
    summaryMerged: 'tasks.triage.summaryMerged',
    summaryReview: 'tasks.triage.summaryReview',
    summaryBlocked: 'tasks.triage.summaryBlocked',
    summaryChanges: 'tasks.triage.summaryChanges',
    summaryAssumed: 'tasks.triage.summaryAssumed',
    // Group headings.
    merged: 'tasks.triage.merged',
    needsReview: 'tasks.triage.needsReview',
    blocked: 'tasks.triage.blocked',
    changesRequested: 'tasks.triage.changesRequested',
    assumed: 'tasks.triage.assumed',
    assumedHint: 'tasks.triage.assumedHint',
  },

  // Statuses
  prState: {
    open: 'tasks.prState.open',
    merged: 'tasks.prState.merged',
    closed: 'tasks.prState.closed',
  },

  ciState: {
    pending: 'tasks.ciState.pending',
    passing: 'tasks.ciState.passing',
    failing: 'tasks.ciState.failing',
  },

  // Why the red is red — classification badge next to the CI dot.
  ciFailureKind: {
    retryable: 'tasks.ciFailureKind.retryable',
    setup: 'tasks.ciFailureKind.setup',
    external: 'tasks.ciFailureKind.external',
  },

  status: {
    draft: 'tasks.status.draft',
    ready: 'tasks.status.ready',
    in_progress: 'tasks.status.in_progress',
    blocked: 'tasks.status.blocked',
    needs_review: 'tasks.status.needs_review',
    approved: 'tasks.status.approved',
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
    approveMerge: 'tasks.actions.approveMerge',
    merge: 'tasks.actions.merge',
    mergeAllGreen: 'tasks.actions.mergeAllGreen',
    undoApprove: 'tasks.actions.undoApprove',
    markMerged: 'tasks.actions.markMerged',
    requestChanges: 'tasks.actions.requestChanges',
    reopenWithFeedback: 'tasks.actions.reopenWithFeedback',
    cancelTask: 'tasks.actions.cancelTask',
    deleteDraft: 'tasks.actions.deleteDraft',
    feedbackPlaceholder: 'tasks.actions.feedbackPlaceholder',
    answerPlaceholder: 'tasks.actions.answerPlaceholder',
    confirm: 'tasks.actions.confirm',
  },

  // Confirm dialog shown before cancelling a task that other live tasks depend on
  cancelConfirm: {
    title: 'tasks.cancelConfirm.title',
    body: 'tasks.cancelConfirm.body',
    confirm: 'tasks.cancelConfirm.confirm',
    keep: 'tasks.cancelConfirm.keep',
  },

  // Project automation modes
  mode: {
    label: 'tasks.mode.label',
    manual: 'tasks.mode.manual',
    manualHint: 'tasks.mode.manualHint',
    auto_merge: 'tasks.mode.auto_merge',
    autoMergeHint: 'tasks.mode.autoMergeHint',
    auto: 'tasks.mode.auto',
    autoHint: 'tasks.mode.autoHint',
    maxParallel: 'tasks.mode.maxParallel',
    maxParallelHint: 'tasks.mode.maxParallelHint',
    paused: 'tasks.mode.paused',
    pausedKind: 'tasks.mode.pausedKind',
    pausedHint: 'tasks.mode.pausedHint',
    resume: 'tasks.mode.resume',
    budget: 'tasks.mode.budget',
    spend: 'tasks.mode.spend',
    pausedBudget: 'tasks.mode.pausedBudget',
  },

  // Pipeline project view (/v2/projects/:id)
  v2: {
    untitled: 'tasks.v2.untitled',
    dispatchPaused: 'tasks.v2.dispatchPaused',
    agentSummary: 'tasks.v2.agentSummary',
    noSummary: 'tasks.v2.noSummary',
    diffStats: 'tasks.v2.diffStats',
    touches: 'tasks.v2.touches',
    // Lineage chip: the research document a ticket was cut from.
    fromResearch: 'tasks.v2.fromResearch',
    // Collapsed-row dependency indicators (icon + count; tooltip lists which).
    dependsOn: 'tasks.v2.dependsOn',
    blocks: 'tasks.v2.blocks',
    waitingOn: 'tasks.v2.waitingOn',
    waitingHeading: 'tasks.v2.waitingHeading',
    ciGreenHint: 'tasks.v2.ciGreenHint',
    mergeBlockedCi: 'tasks.v2.mergeBlockedCi',
    prClosedHint: 'tasks.v2.prClosedHint',
    merging: 'tasks.v2.merging',
    mergedToast: 'tasks.v2.mergedToast',
    approvedToast: 'tasks.v2.approvedToast',
    question: 'tasks.v2.question',
    stageEmpty: {
      generic: 'tasks.v2.stageEmpty.generic',
      ready: 'tasks.v2.stageEmpty.ready',
      needs_review: 'tasks.v2.stageEmpty.needs_review',
      approved: 'tasks.v2.stageEmpty.approved',
      done: 'tasks.v2.stageEmpty.done',
    },
  },

  // Plan mode: the draft-only dependency planner canvas (Board ⇄ Plan toggle).
  plan: {
    board: 'tasks.plan.board',
    plan: 'tasks.plan.plan',
    tidy: 'tasks.plan.tidy',
    newTicket: 'tasks.plan.newTicket',
    note: 'tasks.plan.note',
    empty: 'tasks.plan.empty',
    noArea: 'tasks.plan.noArea',
    promote: 'tasks.plan.promote',
    deleteDraft: 'tasks.plan.deleteDraft',
    cardMenu: 'tasks.plan.cardMenu',
    linkHandle: 'tasks.plan.linkHandle',
    removeDependency: 'tasks.plan.removeDependency',
    clear: 'tasks.plan.clear',
    waiting: 'tasks.plan.waiting',
    clearLegend: 'tasks.plan.clearLegend',
    waitingLegend: 'tasks.plan.waitingLegend',
    linkLegend: 'tasks.plan.linkLegend',
    legendTitle: 'tasks.plan.legendTitle',
    hint: 'tasks.plan.hint',
    // Promote-with-cascade confirm.
    promoteChainTitle: 'tasks.plan.promoteChainTitle',
    promoteChainBody: 'tasks.plan.promoteChainBody',
    // Inline rejection feedback for illegal links.
    rejectSelf: 'tasks.plan.rejectSelf',
    rejectDuplicate: 'tasks.plan.rejectDuplicate',
    rejectCycle: 'tasks.plan.rejectCycle',
  },

  // Bulk "mark as ready" — the project cog, the per-group menu, and the toast
  // the single-task action shows when it pulls in a prerequisite.
  markReady: {
    all: 'tasks.markReady.all',
    group: 'tasks.markReady.group',
    projectMenu: 'tasks.markReady.projectMenu',
    groupMenu: 'tasks.markReady.groupMenu',
    confirmAllTitle: 'tasks.markReady.confirmAllTitle',
    confirmAllBody: 'tasks.markReady.confirmAllBody',
    confirmGroupTitle: 'tasks.markReady.confirmGroupTitle',
    confirmGroupBody: 'tasks.markReady.confirmGroupBody',
    confirm: 'tasks.markReady.confirm',
    alsoPromoted: 'tasks.markReady.alsoPromoted',
    done: 'tasks.markReady.done',
    none: 'tasks.markReady.none',
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
    removeDependency: 'tasks.detail.removeDependency',
    noDependencies: 'tasks.detail.noDependencies',
    dependencyPlaceholder: 'tasks.detail.dependencyPlaceholder',
    dependencySearch: 'tasks.detail.dependencySearch',
    dependencyEmpty: 'tasks.detail.dependencyEmpty',
    agent: 'tasks.detail.agent',
    you: 'tasks.detail.you',
    kind: {
      comment: 'tasks.detail.kind.comment',
      progress: 'tasks.detail.kind.progress',
      question: 'tasks.detail.kind.question',
      answer: 'tasks.detail.kind.answer',
      note: 'tasks.detail.kind.note',
    },
    noteToggle: 'tasks.detail.noteToggle',
    sendNote: 'tasks.detail.sendNote',
    noteSeen: 'tasks.detail.noteSeen',
    notePending: 'tasks.detail.notePending',
  },

  // Errors
  errors: {
    githubNotConnected: 'tasks.errors.githubNotConnected',
    projectNotBound: 'tasks.errors.projectNotBound',
    repoDroppedFromGrant: 'tasks.errors.repoDroppedFromGrant',
    repoNotInGrant: 'tasks.errors.repoNotInGrant',
    repoProvisionUnavailable: 'tasks.errors.repoProvisionUnavailable',
    repoProvisionFailed: 'tasks.errors.repoProvisionFailed',
    repoNameTaken: 'tasks.errors.repoNameTaken',
    repoNameInvalid: 'tasks.errors.repoNameInvalid',
    projectNameTaken: 'tasks.errors.projectNameTaken',
    projectArchivedReadonly: 'tasks.errors.projectArchivedReadonly',
    repoProvisionNotGranted: 'tasks.errors.repoProvisionNotGranted',
    projectNotFound: 'tasks.errors.projectNotFound',
    notFound: 'tasks.errors.notFound',
    notEditable: 'tasks.errors.notEditable',
    invalidTransition: 'tasks.errors.invalidTransition',
    mergeNotApproved: 'tasks.errors.mergeNotApproved',
    mergeCiFailing: 'tasks.errors.mergeCiFailing',
    mergeConflict: 'tasks.errors.mergeConflict',
    mergeNoPr: 'tasks.errors.mergeNoPr',
    dispatchGate: 'tasks.errors.dispatchGate',
    reviewGate: 'tasks.errors.reviewGate',
    costNotClaimant: 'tasks.errors.costNotClaimant',
    assumptionNotClaimant: 'tasks.errors.assumptionNotClaimant',
    noteHumanOnly: 'tasks.errors.noteHumanOnly',
    noteNotInProgress: 'tasks.errors.noteNotInProgress',
    notesNotClaimant: 'tasks.errors.notesNotClaimant',
    unackedNotes: 'tasks.errors.unackedNotes',
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
