import { describe, expect, it } from 'vitest';
import { projectTaskList, toTaskSummary } from '@/mcp/mcp-tools.js';

/**
 * `list_tasks` used to return every task in full. One page of 39 came to about
 * 150KB and overran the tool-result budget, so the board was cheaper to read by
 * dumping it to a file and parsing it than by calling the API — which is the
 * opposite of what a list is for.
 *
 * These pin the projection: enough to CHOOSE a task, never enough to read one.
 */

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  title: 'Halt when a feed goes stale',
  status: 'draft',
  priority: 900,
  area: 'risk',
  assignee: null,
  claimedBy: null,
  branch: 'fix/stale',
  prUrl: 'https://github.com/x/y/pull/1',
  ciState: 'passing',
  isHumanTask: false,
  assumptionFlag: null,
  updatedAt: '2026-10-02T09:00:00.000Z',
  context: 'x'.repeat(4000),
  outOfScope: 'y'.repeat(2000),
  acceptanceCriteria: [
    { text: 'a', done: true },
    { text: 'b', done: false },
    { text: 'c', done: false },
  ],
  dependencies: [{ id: 'd1' }, { id: 'd2' }],
  dependents: [{ id: 'd3' }],
};

describe('toTaskSummary', () => {
  it('keeps what you need to choose a task', () => {
    const s = toTaskSummary(task);

    expect(s).toMatchObject({
      id: task.id,
      title: 'Halt when a feed goes stale',
      status: 'draft',
      priority: 900,
      area: 'risk',
      branch: 'fix/stale',
      prUrl: task.prUrl,
      ciState: 'passing',
    });
  });

  /** The bulk of the old payload — and the reason it overran. */
  it('drops the long prose entirely', () => {
    const s = toTaskSummary(task);

    expect(s).not.toHaveProperty('context');
    expect(s).not.toHaveProperty('outOfScope');
    expect(JSON.stringify(s).length).toBeLessThan(600);
  });

  it('collapses criteria to a done/total ratio rather than their texts', () => {
    expect(toTaskSummary(task).criteria).toBe('1/3');
    expect(JSON.stringify(toTaskSummary(task))).not.toContain('"text"');
  });

  it('reports no criteria as null, not 0/0', () => {
    expect(toTaskSummary({ ...task, acceptanceCriteria: [] }).criteria).toBe(null);
  });

  /** Edge indicators matter on a board; the edges themselves do not. */
  it('counts dependencies instead of listing them', () => {
    const s = toTaskSummary(task);

    expect(s.dependencies).toBe(2);
    expect(s.dependents).toBe(1);
  });

  it('survives a task missing the optional collections', () => {
    const s = toTaskSummary({ id: 'x', title: 't', status: 'draft' });

    expect(s).toMatchObject({ id: 'x', criteria: null, dependencies: 0, dependents: 0 });
  });
});

describe('projectTaskList', () => {
  const page = { data: [task], meta: { total: 1, skip: 0, limit: 20 } };

  it('summarises every row by default', () => {
    const out = projectTaskList(page, 'summary');

    expect((out.data as unknown[]).length).toBe(1);
    expect((out.data as Record<string, unknown>[])[0]).not.toHaveProperty('context');
  });

  /** Paging is how an agent decides whether to ask again — never projected away. */
  it('leaves meta untouched', () => {
    expect(projectTaskList(page, 'summary').meta).toEqual(page.meta);
  });

  it('returns whole tasks when full is asked for', () => {
    const out = projectTaskList(page, 'full');

    expect((out.data as Record<string, unknown>[])[0]).toHaveProperty('context');
  });

  it('passes through a response with no data array', () => {
    const odd = { meta: { total: 0 } };

    expect(projectTaskList(odd, 'summary')).toEqual(odd);
  });
});
