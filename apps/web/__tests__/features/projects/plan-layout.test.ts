import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '@pkg/contracts';
import {
  buildPlanGraph,
  cycleChain,
  draftEdges,
  draftPrereqsOf,
  isWaiting,
} from '@/features/projects/components/plan/plan-layout';
import { makeTask } from './helpers';

/**
 * The pure core behind the Plan-mode canvas — browserless. Asserts the
 * draft→edge extraction, the depth×lane graph shape, the clear/waiting state,
 * and the cycle pre-check that gives the canvas its instant "would loop" flash.
 */

const dep = (id: string, status: TaskStatus = 'draft') => ({ id, title: id, status });

/** Task A depends on the given prerequisite ids. */
const task = (id: string, deps: string[] = [], area: string | null = 'web'): Task =>
  makeTask({ id, area, dependencies: deps.map((d) => dep(d)) });

describe('draftEdges', () => {
  it('emits [prerequisite, dependent] only for on-canvas endpoints', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['ghost'])];
    // b depends on a → edge a→b; c depends on an off-canvas task → dropped.
    expect(draftEdges(tasks)).toEqual([['a', 'b']]);
  });
});

describe('isWaiting / draftPrereqsOf', () => {
  it('is clear with no prerequisites and waiting with an unmet one', () => {
    expect(isWaiting(task('a'))).toBe(false);
    expect(isWaiting(task('b', ['a']))).toBe(true);
  });

  it('treats a done prerequisite as met (clear)', () => {
    const t = makeTask({ id: 'b', dependencies: [dep('a', 'done')] });
    expect(isWaiting(t)).toBe(false);
    expect(draftPrereqsOf(t)).toEqual([]);
  });

  it('lists only draft prerequisites for the promote cascade', () => {
    const t = makeTask({
      id: 'c',
      dependencies: [dep('a', 'draft'), dep('b', 'ready'), dep('x', 'done')],
    });
    expect(draftPrereqsOf(t)).toEqual(['a']);
  });
});

describe('cycleChain', () => {
  const edges: Array<[string, string]> = [
    ['a', 'b'],
    ['b', 'c'],
  ];

  it('returns null when the new edge is safe', () => {
    // a→d closes no loop.
    expect(cycleChain(edges, 'a', 'd')).toBeNull();
  });

  it('detects a cycle and returns the conflicting chain', () => {
    // Adding "a depends on c" (prereq c, dependent a) loops: a→b→c already
    // reaches back, so the chain a…c is flagged.
    const chain = cycleChain(edges, 'c', 'a');
    expect(chain).not.toBeNull();
    expect(chain![0]).toBe('a');
    expect(chain![chain!.length - 1]).toBe('c');
  });
});

describe('buildPlanGraph', () => {
  it('creates one lane per area (with counts) plus a parented node per task', () => {
    const graph = buildPlanGraph([
      task('a', [], 'web'),
      task('b', ['a'], 'web'),
      task('c', [], 'api'),
    ]);

    const lanes = graph.nodes.filter((n) => n.type === 'lane');
    const cards = graph.nodes.filter((n) => n.type === 'task');
    expect(lanes.map((l) => l.id).sort()).toEqual(['lane:api', 'lane:web']);
    // The web lane holds two tickets.
    const web = lanes.find((l) => l.id === 'lane:web');
    expect((web!.data as { count: number }).count).toBe(2);

    // Every card is parented to its area lane and clamped to it.
    for (const card of cards) {
      expect(card.parentId).toBe(`lane:${(card.data as { task: Task }).task.area}`);
      expect(card.extent).toBe('parent');
    }

    // Lane parents precede their children in the array (a React Flow rule).
    const firstCard = graph.nodes.findIndex((n) => n.type === 'task');
    const lastLane = graph.nodes.map((n) => n.type).lastIndexOf('lane');
    expect(lastLane).toBeLessThan(firstCard);

    // The dependency shows up as an edge a→b.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: 'a', target: 'b', type: 'dep' });
  });
});
