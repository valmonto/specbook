import { describe, expect, it } from 'vitest';
import {
  AGENT_TASK_TRANSITIONS,
  ASSIGNEE_TASK_TRANSITIONS,
  HUMAN_TASK_TRANSITIONS,
} from '../src';

describe('the task status protocol — transition maps', () => {
  // The stranded-work recovery path: a task whose PR merged out-of-band can be
  // marked done directly from draft. Human court only.
  it('allows the human draft → done recovery edge', () => {
    expect(HUMAN_TASK_TRANSITIONS.draft).toContain('done');
  });

  it('keeps draft → ready dispatch and draft → cancelled alongside it', () => {
    expect(HUMAN_TASK_TRANSITIONS.draft).toEqual(
      expect.arrayContaining(['ready', 'done', 'cancelled']),
    );
  });

  // The whole point of a separate agent court: `done` is never an agent target,
  // from any state. draft → done must stay a human-only move so nothing can
  // ship its own work without review.
  it('bars agents from ever reaching done or approved', () => {
    for (const targets of Object.values(AGENT_TASK_TRANSITIONS)) {
      expect(targets).not.toContain('done');
      expect(targets).not.toContain('approved');
    }
    // Agents have no `draft` moves at all — draft is the human dispatch court.
    expect(AGENT_TASK_TRANSITIONS.draft).toBeUndefined();
  });

  // A human-task assignee is an executor (like an agent), not the owner, so the
  // recovery edge is the owner's alone — the assignee court must not carry it.
  it('bars the assignee court from draft → done', () => {
    expect(ASSIGNEE_TASK_TRANSITIONS.draft).toBeUndefined();
    for (const targets of Object.values(ASSIGNEE_TASK_TRANSITIONS)) {
      expect(targets).not.toContain('done');
    }
  });
});
