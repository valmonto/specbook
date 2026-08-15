import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '@pkg/contracts';
import {
  blockersOf,
  buildPlanLayout,
  clampToLane,
  cycleChain,
  draftEdges,
  edgeMid,
  edgePoints,
  isWaiting,
  longestPathDepths,
  unlocksOf,
  PLAN_NODE_W,
  type LaneRect,
} from '@/features/projects/components/plan/plan-layout';
import { makeTask } from './helpers';

/**
 * The pure core behind the Plan canvas (the hand-rolled depth × lane engine) —
 * browserless. Asserts the draft→edge extraction, the longest-path depth
 * layering, the depth × lane positioning, the lane clamp that keeps a card in
 * its own area, the edge geometry, and the cycle pre-check that gives the canvas
 * its instant "would loop" flash. The load-bearing property is that same-lane
 * cards never overlap (using measured heights); and mobile (compact) makes the
 * lane containers larger.
 */

const dep = (id: string, status: TaskStatus = 'draft') => ({ id, title: id, status });
const task = (id: string, deps: string[] = [], area: string | null = 'web'): Task =>
  makeTask({ id, area, dependencies: deps.map((d) => dep(d)) });

describe('draftEdges', () => {
  it('emits [prerequisite, dependent] only for on-canvas endpoints', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['ghost'])];
    // b depends on a → edge a→b; c depends on an off-canvas task → dropped.
    expect(draftEdges(tasks)).toEqual([['a', 'b']]);
  });
});

describe('isWaiting', () => {
  it('is clear with no prerequisites and waiting with an unmet one', () => {
    expect(isWaiting(task('a'))).toBe(false);
    expect(isWaiting(task('b', ['a']))).toBe(true);
  });

  it('treats a done prerequisite as met (clear)', () => {
    expect(isWaiting(makeTask({ id: 'b', dependencies: [dep('a', 'done')] }))).toBe(false);
  });
});

describe('longestPathDepths', () => {
  it('ranks each node by its deepest prerequisite chain', () => {
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'], // direct a→c must not shorten c's depth below the a→b→c path
    ];
    const depth = longestPathDepths(['a', 'b', 'c'], edges);
    expect(depth.get('a')).toBe(0);
    expect(depth.get('b')).toBe(1);
    expect(depth.get('c')).toBe(2);
  });

  it('treats every unlinked node as a depth-0 root', () => {
    const depth = longestPathDepths(['a', 'b'], []);
    expect(depth.get('a')).toBe(0);
    expect(depth.get('b')).toBe(0);
  });

  it('does not loop forever on a defensively-handled cycle', () => {
    const depth = longestPathDepths(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    expect(depth.size).toBe(2);
  });
});

describe('blockersOf / unlocksOf', () => {
  const edges: Array<[string, string]> = [
    ['a', 'b'],
    ['a', 'c'],
    ['b', 'c'],
  ];
  it('reads prerequisites and dependents from the edge set', () => {
    expect(blockersOf(edges, 'c').sort()).toEqual(['a', 'b']);
    expect(unlocksOf(edges, 'a').sort()).toEqual(['b', 'c']);
    expect(blockersOf(edges, 'a')).toEqual([]);
  });
});

describe('cycleChain', () => {
  const edges: Array<[string, string]> = [
    ['a', 'b'],
    ['b', 'c'],
  ];

  it('returns null when the new edge is safe', () => {
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

describe('buildPlanLayout', () => {
  it('lays out one lane per area with per-area ticket counts', () => {
    const { lanes, positions } = buildPlanLayout([
      task('a', [], 'web'),
      task('b', ['a'], 'web'),
      task('c', [], 'api'),
    ]);
    expect(lanes.map((l) => l.area).sort()).toEqual(['api', 'web']);
    const web = lanes.find((l) => l.area === 'web')!;
    expect(web.count).toBe(2);
    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c']);
  });

  it('places a dependent to the right of its prerequisite (x = depth)', () => {
    const { positions } = buildPlanLayout([task('a', [], 'web'), task('b', ['a'], 'web')]);
    expect(positions.b!.x).toBeGreaterThan(positions.a!.x);
  });

  it('stacks two roots in the same lane vertically at the same x', () => {
    const { positions } = buildPlanLayout([task('a', [], 'web'), task('b', [], 'web')]);
    expect(positions.a!.x).toBe(positions.b!.x);
    expect(positions.a!.y).not.toBe(positions.b!.y);
  });

  it('sits lanes in separate horizontal bands (no vertical overlap)', () => {
    const { lanes } = buildPlanLayout([task('a', [], 'web'), task('c', [], 'api')]);
    const [first, second] = [...lanes].sort((l1, l2) => l1.top - l2.top);
    expect(first!.top + first!.height).toBeLessThanOrEqual(second!.top);
  });
});

describe('buildPlanLayout collision-free invariants', () => {
  const overlaps1D = (a: number, ah: number, b: number, bh: number): boolean =>
    a < b + bh && b < a + ah;

  it('(a) never vertically overlaps two stacked cards, given variable heights', () => {
    // Three depth-0 roots in one lane → one column → they stack vertically. Feed
    // wildly different measured heights (a 1-line, a 3-line and a 2-line title).
    const tasks = [task('a', [], 'web'), task('b', [], 'web'), task('c', [], 'web')];
    const heights: Record<string, number> = { a: 200, b: 58, c: 132 };
    for (const compact of [false, true]) {
      const { positions } = buildPlanLayout(tasks, { heights, compact });
      const ids = ['a', 'b', 'c'];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const p = positions[ids[i]!]!;
          const q = positions[ids[j]!]!;
          expect(p.x).toBe(q.x); // same column
          expect(overlaps1D(p.y, heights[ids[i]!]!, q.y, heights[ids[j]!]!)).toBe(false);
        }
      }
    }
  });

  it('(b) separates adjacent depth columns by at least the card width', () => {
    const desk = buildPlanLayout([task('a', [], 'web'), task('b', ['a'], 'web')]);
    const phone = buildPlanLayout([task('a', [], 'web'), task('b', ['a'], 'web')], {
      compact: true,
    });
    for (const { positions } of [desk, phone]) {
      // depth-1 x minus depth-0 x is the column pitch; it must clear a card.
      expect(positions.b!.x - positions.a!.x).toBeGreaterThan(PLAN_NODE_W);
    }
  });

  it('(c) sizes each lane tall enough to contain its whole card stack', () => {
    const tasks = [task('a', [], 'web'), task('b', [], 'web')];
    const heights: Record<string, number> = { a: 180, b: 120 };
    const { positions, lanes } = buildPlanLayout(tasks, { heights });
    const lane = lanes.find((l) => l.area === 'web')!;
    for (const id of ['a', 'b']) {
      const p = positions[id]!;
      expect(p.y).toBeGreaterThanOrEqual(lane.top);
      expect(p.y + heights[id]!).toBeLessThanOrEqual(lane.top + lane.height);
    }
  });

  it('keeps every card inside its lane on the x axis, including the deepest', () => {
    const tasks = [task('a', [], 'web'), task('b', ['a'], 'web'), task('c', ['b'], 'web')];
    const { positions, lanes } = buildPlanLayout(tasks);
    const lane = lanes.find((l) => l.area === 'web')!;
    for (const id of ['a', 'b', 'c']) {
      const p = positions[id]!;
      expect(p.x).toBeGreaterThanOrEqual(lane.left);
      expect(p.x + PLAN_NODE_W).toBeLessThanOrEqual(lane.left + lane.width);
    }
  });
});

describe('buildPlanLayout mobile (compact) lane containers', () => {
  it('makes lane containers larger on mobile than on desktop', () => {
    const tasks = [task('a', [], 'web'), task('b', [], 'web'), task('c', [], 'web')];
    const heights: Record<string, number> = { a: 92, b: 92, c: 92 };
    const deskLane = buildPlanLayout(tasks, { heights }).lanes[0]!;
    const mobLane = buildPlanLayout(tasks, { heights, compact: true }).lanes[0]!;
    // Taller container on mobile: more padding + a wider inter-card gap.
    expect(mobLane.height).toBeGreaterThan(deskLane.height);
  });

  it('applies a taller minimum lane height on mobile (single-card lane)', () => {
    const one = [task('solo', [], 'web')];
    const heights: Record<string, number> = { solo: 92 };
    const mobile = buildPlanLayout(one, { heights, compact: true }).lanes[0]!;
    const desktop = buildPlanLayout(one, { heights }).lanes[0]!;
    expect(mobile.height).toBeGreaterThan(desktop.height);
  });
});

describe('clampToLane', () => {
  const rect: LaneRect = {
    area: 'web',
    left: 20,
    top: 100,
    width: 600,
    height: 300,
    count: 1,
    color: { stroke: '#000', tint: '#fff', dot: '#000' },
  };
  it('keeps a card inside its lane on both axes', () => {
    const clamped = clampToLane(rect, 9999, 9999, 90);
    expect(clamped.x).toBe(rect.left + rect.width - PLAN_NODE_W - 12);
    expect(clamped.y).toBe(rect.top + rect.height - 90 - 10);
    const clampedLow = clampToLane(rect, -9999, -9999, 90);
    expect(clampedLow.x).toBe(rect.left + 12);
    expect(clampedLow.y).toBeGreaterThanOrEqual(rect.top);
  });
});

describe('edge geometry', () => {
  it('anchors from the source right edge to the target left edge, midpoint between', () => {
    const pts = edgePoints({ x: 0, y: 0 }, { x: 400, y: 100 }, 90, 90);
    expect(pts.x1).toBe(PLAN_NODE_W);
    expect(pts.x2).toBe(400);
    const mid = edgeMid(pts);
    expect(mid.x).toBeGreaterThan(pts.x1);
    expect(mid.x).toBeLessThan(pts.x2);
  });
});
