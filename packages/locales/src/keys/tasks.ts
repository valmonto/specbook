/**
 * Projects & tasks translation keys
 */
export const tasks = {
  // Errors
  errors: {
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
