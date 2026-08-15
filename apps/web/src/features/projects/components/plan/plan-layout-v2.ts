import type { Task } from '@pkg/contracts';
import { groupTasksByArea } from '../v2/group-tasks';
import { draftEdges, isWaiting, laneColor } from './plan-layout';

/**
 * Plan v2 — the pure, browserless layout core for the hand-rolled canvas
 * (no React Flow, no dagre). It ports the reference mockup's engine: a
 * depth × lane grid where x is dependency DEPTH (longest-path layering, so a
 * prerequisite sits left of what it unlocks) and each horizontal band is an
 * AREA lane. Same-depth siblings stack vertically inside their lane. Everything
 * here is a plain function of the draft task set so it can be unit-tested like
 * plan-layout.ts; the component ({@link ./plan-canvas-v2}) owns the DOM, pointer
 * events and SVG, and calls back into these helpers.
 */

// Card + grid geometry (translated from the mockup, kept in canvas pixels — the
// v2 canvas has no zoom, so layout units are screen units).
export const V2_NODE_W = 236;
/** Estimated card height used only as an edge-anchor fallback before measuring. */
export const V2_CARD_H = 92;
const V2_COL_W = 288;
const V2_ROW_H = 120;
export const V2_LANE_X = 20;
const V2_CARD_PAD_X = 32;
export const V2_LANE_TOP_PAD = 40;
const V2_LANE_BOT_PAD = 22;
const V2_LANE_GAP = 22;

export interface V2Point {
  x: number;
  y: number;
}

export interface V2LaneRect {
  area: string;
  left: number;
  top: number;
  width: number;
  height: number;
  count: number;
  color: { stroke: string; tint: string; dot: string };
}

export interface V2Layout {
  positions: Record<string, V2Point>;
  lanes: V2LaneRect[];
  width: number;
  height: number;
}

/**
 * Longest-path depth per node: 0 for a root with no on-canvas prerequisite,
 * otherwise one more than its deepest prerequisite. Memoised, and the memo is
 * seeded to 0 before recursing so a (server-rejected, but defensively handled)
 * cycle can't loop forever.
 */
export function longestPathDepths(
  ids: string[],
  edges: Array<[string, string]>,
): Map<string, number> {
  const blockers = new Map<string, string[]>();
  for (const [b, d] of edges) (blockers.get(d) ?? blockers.set(d, []).get(d)!).push(b);
  const memo = new Map<string, number>();
  const calc = (id: string): number => {
    const seen = memo.get(id);
    if (seen !== undefined) return seen;
    memo.set(id, 0); // cycle guard
    let m = 0;
    for (const b of blockers.get(id) ?? []) m = Math.max(m, calc(b) + 1);
    memo.set(id, m);
    return m;
  };
  for (const id of ids) calc(id);
  return memo;
}

/** Prerequisites of a node (the ids it depends on) within the given edge set. */
export const blockersOf = (edges: Array<[string, string]>, id: string): string[] =>
  edges.filter(([, d]) => d === id).map(([b]) => b);

/** Nodes this one unlocks (its dependents) within the given edge set. */
export const unlocksOf = (edges: Array<[string, string]>, id: string): string[] =>
  edges.filter(([b]) => b === id).map(([, d]) => d);

/**
 * Build the depth × lane layout for a set of draft tasks: absolute card
 * positions, one labelled lane rectangle per area, and the overall canvas size.
 * Re-run on every structural change to keep the board tidy (the Tidy button and
 * the auto-tidy both call this).
 */
export function layoutV2(tasks: Task[]): V2Layout {
  const ids = tasks.map((t) => t.id);
  const edges = draftEdges(tasks);
  const depth = longestPathDepths(ids, edges);
  const groups = groupTasksByArea(tasks); // busiest-first, no-area last
  const maxLayer = Math.max(0, ...[...depth.values()]);
  const contentW = V2_LANE_X + V2_CARD_PAD_X + (maxLayer + 1) * V2_COL_W + 14;
  const laneW = contentW - V2_LANE_X * 2;

  const positions: Record<string, V2Point> = {};
  const lanes: V2LaneRect[] = [];
  let y = V2_LANE_GAP;

  for (const [area, groupTasks] of groups) {
    const perLayer = new Map<number, Task[]>();
    for (const task of groupTasks) {
      const d = depth.get(task.id) ?? 0;
      (perLayer.get(d) ?? perLayer.set(d, []).get(d)!).push(task);
    }
    const maxStack = Math.max(1, ...[...perLayer.values()].map((c) => c.length));
    const height = V2_LANE_TOP_PAD + maxStack * V2_ROW_H + V2_LANE_BOT_PAD;

    for (const [layer, list] of perLayer) {
      list.forEach((task, i) => {
        positions[task.id] = {
          x: V2_LANE_X + V2_CARD_PAD_X + layer * V2_COL_W,
          y: y + V2_LANE_TOP_PAD + i * V2_ROW_H,
        };
      });
    }

    lanes.push({
      area,
      left: V2_LANE_X,
      top: y,
      width: laneW,
      height,
      count: groupTasks.length,
      color: laneColor(area),
    });
    y += height + V2_LANE_GAP;
  }

  return { positions, lanes, width: Math.max(contentW, 900), height: Math.max(y, 420) };
}

/** Clamp a dragged card so it can be nudged but never leaves its own lane. */
export function clampToLane(
  rect: V2LaneRect,
  x: number,
  y: number,
  cardH: number,
): V2Point {
  return {
    x: Math.max(rect.left + 12, Math.min(rect.left + rect.width - V2_NODE_W - 12, x)),
    y: Math.max(rect.top + V2_LANE_TOP_PAD - 8, Math.min(rect.top + rect.height - cardH - 10, y)),
  };
}

export interface V2EdgePts {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
}

/** Cubic-bezier control points from a source card's right edge to a target's left. */
export function edgePoints(
  from: V2Point,
  to: V2Point,
  fromH: number = V2_CARD_H,
  toH: number = V2_CARD_H,
): V2EdgePts {
  const x1 = from.x + V2_NODE_W;
  const y1 = from.y + fromH / 2;
  const x2 = to.x;
  const y2 = to.y + toH / 2;
  const dx = Math.max(46, Math.abs(x2 - x1) * 0.45);
  return { x1, y1, x2, y2, c1x: x1 + dx, c1y: y1, c2x: x2 - dx, c2y: y2 };
}

export const edgePath = (p: V2EdgePts): string =>
  `M ${p.x1} ${p.y1} C ${p.c1x} ${p.c1y}, ${p.c2x} ${p.c2y}, ${p.x2} ${p.y2}`;

/** The point on a cubic bezier at t = 0.5 — where the delete ✕ sits. */
export const edgeMid = (p: V2EdgePts): V2Point => ({
  x: 0.125 * p.x1 + 0.375 * p.c1x + 0.375 * p.c2x + 0.125 * p.x2,
  y: 0.125 * p.y1 + 0.375 * p.c1y + 0.375 * p.c2y + 0.125 * p.y2,
});

/** Bezier from a fixed source point to a free pointer (the live drag link). */
export function tempLinkPath(from: V2Point, fromH: number, px: number, py: number): string {
  const x1 = from.x + V2_NODE_W;
  const y1 = from.y + fromH / 2;
  const dx = Math.max(40, Math.abs(px - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${px - dx} ${py}, ${px} ${py}`;
}

/** Re-export so the canvas imports its whole vocabulary from one module. */
export { draftEdges, isWaiting };
