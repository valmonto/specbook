import type { CiFailureKind } from '@pkg/contracts';

/**
 * Classifies WHY a red check is red, from run/job conclusions and step names
 * only — never job logs. Conservative by contract: anything not positively
 * recognized returns null (plain red), because a wrong "retryable" would make
 * the breaker ignore a real regression.
 */

export interface CiJobStep {
  name: string;
  conclusion: string | null;
}

export interface CiJob {
  name: string;
  conclusion: string | null;
  steps: CiJobStep[];
}

export interface CiRunFacts {
  /** The workflow_run conclusion GitHub reported (failure, cancelled, …). */
  runConclusion: string;
  /** Jobs of the run; may be empty when the jobs fetch was unavailable. */
  jobs: CiJob[];
}

export interface CiClassification {
  kind: CiFailureKind;
  /** One line naming the culprit — the failed job (and step when telling). */
  pointer: string;
}

/** Steps GitHub itself owns — a failure there is infrastructure, not code. */
const INFRA_STEP = /^(set up job|checkout|download action|initialize containers)/i;

export function classifyCiFailure(facts: CiRunFacts): CiClassification | null {
  // Run-level conclusions that speak for themselves, jobs or not.
  if (facts.runConclusion === 'startup_failure' || facts.runConclusion === 'action_required') {
    // The workflow could not even start: file error, missing permission, or
    // an approval gate — re-running changes nothing.
    return { kind: 'setup', pointer: `workflow ${facts.runConclusion.replace('_', ' ')}` };
  }
  if (['cancelled', 'timed_out', 'stale'].includes(facts.runConclusion)) {
    return { kind: 'retryable', pointer: `run ${facts.runConclusion.replace('_', ' ')}` };
  }

  const failed = facts.jobs.filter((j) =>
    ['failure', 'cancelled', 'timed_out'].includes(j.conclusion ?? ''),
  );
  if (failed.length === 0) return null;

  // Every failed job lost to the clock or a kill signal → flaky infra.
  if (failed.every((j) => j.conclusion === 'cancelled' || j.conclusion === 'timed_out')) {
    const j = failed[0]!;
    return { kind: 'retryable', pointer: `job ${j.name} ${j.conclusion!.replace('_', ' ')}` };
  }

  // A job that died in a GitHub-owned step (checkout, action download,
  // container init) failed on the platform, not on the code under test.
  for (const job of failed) {
    const step = job.steps.find((s) =>
      ['failure', 'cancelled', 'timed_out'].includes(s.conclusion ?? ''),
    );
    if (step && INFRA_STEP.test(step.name)) {
      return { kind: 'external', pointer: `job ${job.name} — ${step.name}` };
    }
  }

  return null;
}
