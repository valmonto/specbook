import type { Task } from '@pkg/contracts';
import { TERMINAL_TASK_STATUSES } from '@pkg/contracts';
import { groupTasksByArea } from '../v2/group-tasks';

/**
 * Plan — the pure, browserless layout core for the hand-rolled dependency canvas
 * (no React Flow, no dagre). It ports the reference mockup's engine: a
 * depth × lane grid where x is dependency DEPTH (longest-path layering, so a
 * prerequisite sits left of what it unlocks) and each horizontal band is an
 * AREA lane. Same-depth siblings stack vertically inside their lane. Everything
 * here is a plain function of the draft task set so it can be unit-tested; the
 * component ({@link ./plan-canvas}) owns the DOM, pointer events and SVG, and
 * calls back into these helpers.
 */

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

// Card + grid geometry (translated from the mockup, kept in canvas pixels — the
// canvas has no zoom, so layout units are screen units).
//
// Card width is FIXED (same on desktop and phone) so the title wraps to a bound
// height (see the `line-clamp` in plan-canvas) rather than the card growing wide
// enough to run off a phone. 236px sits comfortably inside a 390px viewport with
// room for the lane inset, so on mobile we scroll for DEPTH, never width.
export const PLAN_NODE_W = 236;
/** Estimated card height used only as a first-paint fallback before measuring. */
export const CARD_H = 92;
const LANE_X = 20;
const CARD_PAD_X = 32;
const LANE_TOP_PAD = 40;
const LANE_BOT_PAD = 24;
const LANE_GAP = 22;

// Column PITCH is derived from the card width + a gutter, so a depth column can
// never horizontally overlap the next. The gutter is the SAME on desktop and
// phone so the spacing between cards reads identically at every viewport
// (pitch = 236 + 52 = 288). Only the lane CONTAINER padding differs on mobile.
const COL_GAP = 52;
// Vertical GAP between two stacked cards in a lane. Stacking uses each card's
// MEASURED height + this gap (never a fixed row height), so a tall 3-line card
// can never overlap the card beneath it. Same value everywhere for a consistent
// rhythm between mobile and web.
const CARD_GAP = 32;

// Mobile makes the lane CONTAINERS read as substantial boxes rather than thin
// bands: more top/bottom padding, a taller minimum lane height, and the wider
// inter-card gap above. All gated on `compact` — desktop lane sizing is
// untouched. None of these move a card relative to the one beneath it beyond the
// (larger) gap, so the measured-height stacking stays collision-free.
const MOBILE_LANE_TOP_PAD = 56;
const MOBILE_LANE_BOT_PAD = 40;
const MOBILE_MIN_LANE_H = 208;

export interface PlanPoint {
  x: number;
  y: number;
}

export interface LaneRect {
  area: string;
  left: number;
  top: number;
  width: number;
  height: number;
  count: number;
  color: { stroke: string; tint: string; dot: string };
}

export interface PlanLayout {
  positions: Record<string, PlanPoint>;
  lanes: LaneRect[];
  width: number;
  height: number;
}

/** A ticket waits while any of its prerequisites is not yet done/cancelled. */
export const isWaiting = (task: Task): boolean =>
  (task.dependencies ?? []).some((d) => !TERMINAL.has(d.status));

/** The dependency edges among the given draft tasks, as [prerequisite, dependent]. */
export function draftEdges(tasks: Task[]): Array<[string, string]> {
  const ids = new Set(tasks.map((t) => t.id));
  const edges: Array<[string, string]> = [];
  for (const task of tasks) {
    for (const dep of task.dependencies ?? []) {
      // Only edges whose BOTH ends are on the canvas are drawn; a draft may
      // depend on an already-ready/done task that isn't shown here.
      if (ids.has(dep.id)) edges.push([dep.id, task.id]);
    }
  }
  return edges;
}

// A small, stable lane palette. Known area names map to fixed hues (matching
// the concept); anything else hashes into the same set so colours stay stable.
const PALETTE: Array<{ stroke: string; tint: string; dot: string }> = [
  { stroke: '#3a54e0', tint: 'rgba(58,84,224,0.06)', dot: '#3a54e0' }, // indigo/blue
  { stroke: '#0d9488', tint: 'rgba(13,148,136,0.07)', dot: '#0d9488' }, // teal
  { stroke: '#7c53e6', tint: 'rgba(124,83,230,0.07)', dot: '#7c53e6' }, // violet
  { stroke: '#0a97d6', tint: 'rgba(10,151,214,0.07)', dot: '#0a97d6' }, // sky
  { stroke: '#c07d16', tint: 'rgba(192,125,22,0.07)', dot: '#c07d16' }, // amber
  { stroke: '#0f9d63', tint: 'rgba(15,157,99,0.07)', dot: '#0f9d63' }, // emerald
  { stroke: '#c2410c', tint: 'rgba(194,65,12,0.07)', dot: '#c2410c' }, // orange
  { stroke: '#be185d', tint: 'rgba(190,24,93,0.07)', dot: '#be185d' }, // rose
];
const KNOWN: Record<string, number> = { web: 0, api: 1, e2e: 2, db: 3, worker: 4, mobile: 5 };

export function laneColor(area: string): { stroke: string; tint: string; dot: string } {
  const key = area.toLowerCase();
  if (key in KNOWN) return PALETTE[KNOWN[key]!]!;
  let h = 0;
  for (let i = 0; i < area.length; i++) h = (h * 31 + area.charCodeAt(i)) >>> 0;
  // Named areas avoid the slots reserved for the known ones where possible.
  return PALETTE[h % PALETTE.length]!;
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
export interface PlanLayoutOpts {
  /**
   * Phone layout: a slightly tighter column gutter, bigger inter-card gaps, more
   * lane padding and a taller minimum lane height so the lane containers read as
   * substantial boxes and a shallow graph fits the viewport width by default
   * (deeper graphs still scroll horizontally for DEPTH). Desktop (the default)
   * keeps the roomier pitch, the compact lane sizing and the 900px min-width
   * floor.
   */
  compact?: boolean;
  /**
   * Measured card heights by task id (from the rendered DOM). Cards stack using
   * these real heights + a consistent gap so two cards can NEVER vertically
   * overlap regardless of how many lines their titles wrap to. Ids missing from
   * the map fall back to {@link CARD_H} — the estimate used for the very first
   * paint, before the measure pass has run.
   */
  heights?: Record<string, number>;
}

export function buildPlanLayout(tasks: Task[], opts: PlanLayoutOpts = {}): PlanLayout {
  const compact = opts.compact ?? false;
  const heights = opts.heights ?? {};
  // Gaps between/among cards are identical on mobile and web (consistent
  // rhythm); only the lane container padding grows on mobile.
  const colGap = COL_GAP;
  const cardGap = CARD_GAP;
  const laneTopPad = compact ? MOBILE_LANE_TOP_PAD : LANE_TOP_PAD;
  const laneBotPad = compact ? MOBILE_LANE_BOT_PAD : LANE_BOT_PAD;
  const minLaneH = compact ? MOBILE_MIN_LANE_H : 0;
  const colW = PLAN_NODE_W + colGap; // pitch ≥ card width + gutter → no H-overlap
  const minW = compact ? 320 : 900;
  const minH = compact ? 320 : 420;
  const hOf = (id: string): number => heights[id] ?? CARD_H;

  const ids = tasks.map((t) => t.id);
  const edges = draftEdges(tasks);
  const depth = longestPathDepths(ids, edges);
  const groups = groupTasksByArea(tasks); // busiest-first, no-area last
  const maxLayer = Math.max(0, ...[...depth.values()]);
  // The last column's card plus a right inset must fit inside the lane.
  const contentW = LANE_X + CARD_PAD_X + maxLayer * colW + PLAN_NODE_W + CARD_PAD_X;
  const laneW = contentW - LANE_X * 2;

  const positions: Record<string, PlanPoint> = {};
  const lanes: LaneRect[] = [];
  let y = LANE_GAP;

  for (const [area, groupTasks] of groups) {
    const perLayer = new Map<number, Task[]>();
    for (const task of groupTasks) {
      const d = depth.get(task.id) ?? 0;
      (perLayer.get(d) ?? perLayer.set(d, []).get(d)!).push(task);
    }

    // Stack each depth column top-to-bottom using measured heights + a gap. The
    // lane is as tall as its tallest column stack (never below the mobile floor),
    // so no card ever spills out.
    let contentBottom = laneTopPad; // relative to the lane top
    for (const [layer, list] of perLayer) {
      let cy = laneTopPad;
      list.forEach((task) => {
        positions[task.id] = {
          x: LANE_X + CARD_PAD_X + layer * colW,
          y: y + cy,
        };
        cy += hOf(task.id);
        contentBottom = Math.max(contentBottom, cy);
        cy += cardGap; // gap before the next card in this column
      });
    }
    const height = Math.max(minLaneH, contentBottom + laneBotPad);

    lanes.push({
      area,
      left: LANE_X,
      top: y,
      width: laneW,
      height,
      count: groupTasks.length,
      color: laneColor(area),
    });
    y += height + LANE_GAP;
  }

  return { positions, lanes, width: Math.max(contentW, minW), height: Math.max(y, minH) };
}

/** Clamp a dragged card so it can be nudged but never leaves its own lane. */
export function clampToLane(rect: LaneRect, x: number, y: number, cardH: number): PlanPoint {
  return {
    x: Math.max(rect.left + 12, Math.min(rect.left + rect.width - PLAN_NODE_W - 12, x)),
    y: Math.max(rect.top + LANE_TOP_PAD - 8, Math.min(rect.top + rect.height - cardH - 10, y)),
  };
}

export interface EdgePts {
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
  from: PlanPoint,
  to: PlanPoint,
  fromH: number = CARD_H,
  toH: number = CARD_H,
): EdgePts {
  const x1 = from.x + PLAN_NODE_W;
  const y1 = from.y + fromH / 2;
  const x2 = to.x;
  const y2 = to.y + toH / 2;
  const dx = Math.max(46, Math.abs(x2 - x1) * 0.45);
  return { x1, y1, x2, y2, c1x: x1 + dx, c1y: y1, c2x: x2 - dx, c2y: y2 };
}

export const edgePath = (p: EdgePts): string =>
  `M ${p.x1} ${p.y1} C ${p.c1x} ${p.c1y}, ${p.c2x} ${p.c2y}, ${p.x2} ${p.y2}`;

/** The point on a cubic bezier at t = 0.5 — where the delete ✕ sits. */
export const edgeMid = (p: EdgePts): PlanPoint => ({
  x: 0.125 * p.x1 + 0.375 * p.c1x + 0.375 * p.c2x + 0.125 * p.x2,
  y: 0.125 * p.y1 + 0.375 * p.c1y + 0.375 * p.c2y + 0.125 * p.y2,
});

/** Bezier from a fixed source point to a free pointer (the live drag link). */
export function tempLinkPath(from: PlanPoint, fromH: number, px: number, py: number): string {
  const x1 = from.x + PLAN_NODE_W;
  const y1 = from.y + fromH / 2;
  const dx = Math.max(40, Math.abs(px - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${px - dx} ${py}, ${px} ${py}`;
}

/**
 * Would adding "dependent depends on prerequisite" close a cycle? It does when
 * the prerequisite is already reachable from the dependent by following
 * unlocks edges (prereq → dependent). Returns the conflicting chain of node ids
 * (dependent … prerequisite) so the UI can flash it, or null when it is safe.
 */
export function cycleChain(
  edges: Array<[string, string]>,
  prerequisite: string,
  dependent: string,
): string[] | null {
  // Adjacency: node → nodes it unlocks (its dependents).
  const unlocks = new Map<string, string[]>();
  for (const [p, d] of edges) (unlocks.get(p) ?? unlocks.set(p, []).get(p)!).push(d);

  const parent = new Map<string, string>();
  const seen = new Set<string>([dependent]);
  const stack = [dependent];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === prerequisite) {
      // Reconstruct dependent → … → prerequisite.
      const chain = [prerequisite];
      let cur = prerequisite;
      while (cur !== dependent) {
        cur = parent.get(cur)!;
        chain.push(cur);
      }
      return chain.reverse();
    }
    for (const next of unlocks.get(n) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        parent.set(next, n);
        stack.push(next);
      }
    }
  }
  return null;
}
