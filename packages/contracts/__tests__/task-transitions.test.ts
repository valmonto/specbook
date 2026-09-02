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

  // The core of the agent court: `approved` is never an agent target from any
  // state, and `done` is reachable by an agent through exactly ONE edge —
  // cancelled → done, recovering a task the human already cancelled. The review
  // path (needs_review/approved/draft → done) stays human court, so an agent can
  // never ship its own REVIEWED work without review; it can only finish work a
  // human chose to abandon.
  it('bars agents from approved, and from done except the cancelled recovery', () => {
    for (const [from, targets] of Object.entries(AGENT_TASK_TRANSITIONS)) {
      expect(targets).not.toContain('approved');
      if (from !== 'cancelled') {
        expect(targets).not.toContain('done');
      }
    }
    // The sole agent → done edge is the cancelled-work recovery.
    expect(AGENT_TASK_TRANSITIONS.cancelled).toEqual(['done']);
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
