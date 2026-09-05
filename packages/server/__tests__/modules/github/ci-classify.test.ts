import { describe, expect, it } from 'vitest';
import { classifyCiFailure, type CiJob } from '../../../src/modules/github/ci-classify.js';

const job = (name: string, conclusion: string, steps: Array<[string, string]> = []): CiJob => ({
  name,
  conclusion,
  steps: steps.map(([n, c]) => ({ name: n, conclusion: c })),
});

describe('classifyCiFailure', () => {
  it('startup_failure is a setup failure regardless of jobs', () => {
    expect(classifyCiFailure({ runConclusion: 'startup_failure', jobs: [] })).toEqual({
      kind: 'setup',
      pointer: 'workflow startup failure',
    });
  });

  it('a cancelled run is retryable (outage kills, manual cancels)', () => {
    const c = classifyCiFailure({ runConclusion: 'cancelled', jobs: [] });
    expect(c?.kind).toBe('retryable');
  });

  it('a timed-out job among failures is retryable when nothing hard-failed', () => {
    const c = classifyCiFailure({
      runConclusion: 'failure',
      jobs: [job('verify', 'timed_out'), job('lint', 'skipped')],
    });
    expect(c).toEqual({ kind: 'retryable', pointer: 'job verify timed out' });
  });

  it('a job that died in a GitHub-owned step is external', () => {
    const c = classifyCiFailure({
      runConclusion: 'failure',
      jobs: [
        job('verify', 'failure', [
          ['Set up job', 'failure'],
          ['Run tests', 'skipped'],
        ]),
      ],
    });
    expect(c).toEqual({ kind: 'external', pointer: 'job verify — Set up job' });
  });

  it('a plain test failure is NOT classified — unknown stays plain red', () => {
    const c = classifyCiFailure({
      runConclusion: 'failure',
      jobs: [
        job('verify', 'failure', [
          ['Set up job', 'success'],
          ['Run tests', 'failure'],
        ]),
      ],
    });
    expect(c).toBeNull();
  });

  it('failure with no jobs data stays plain red (no guessing)', () => {
    expect(classifyCiFailure({ runConclusion: 'failure', jobs: [] })).toBeNull();
  });

  it('a hard failure alongside a cancelled job is NOT retryable', () => {
    const c = classifyCiFailure({
      runConclusion: 'failure',
      jobs: [
        job('verify', 'failure', [['Run tests', 'failure']]),
        job('e2e', 'cancelled'),
      ],
    });
    expect(c).toBeNull();
  });
});
