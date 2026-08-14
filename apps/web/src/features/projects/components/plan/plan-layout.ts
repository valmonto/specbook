import dagre from 'dagre';
import type { Edge, Node } from '@xyflow/react';
import type { Task } from '@pkg/contracts';
import { TERMINAL_TASK_STATUSES } from '@pkg/contracts';
import { groupTasksByArea } from '../v2/group-tasks';

/**
 * The Plan-mode canvas layout — the pure, testable core (no React, no DOM).
 * Draft tickets lay out as a grid where the x axis is dependency DEPTH and each
 * horizontal band is an AREA lane. dagre computes the depth ranks (rankdir LR,
 * so a prerequisite sits left of what it unlocks); we then bucket the ranked
 * nodes into per-area lanes and stack same-depth siblings vertically. The lane
 * is a React Flow parent node and every ticket is its child (extent:'parent'),
 * which is what clamps a card inside its own lane.
 */

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

// Card + grid geometry. NODE_H is a layout estimate; the DOM card auto-sizes.
export const PLAN_NODE_W = 232;
const NODE_H = 96;
const COL_W = 300;
const ROW_H = 132;
const LANE_PAD_TOP = 44;
const LANE_PAD_BOTTOM = 20;
const LANE_PAD_X = 20;
const LANE_GAP = 26;
const CANVAS_PAD_X = 28;

/** '' is the untagged "no area" bucket — kept distinct from a named area. */
export const areaKeyOf = (task: Task): string => task.area?.trim() ?? '';

/** A ticket waits while any of its prerequisites is not yet done/cancelled. */
export const isWaiting = (task: Task): boolean =>
  (task.dependencies ?? []).some((d) => !TERMINAL.has(d.status));

/** Draft prerequisites still on the canvas — the promote-cascade offer reads this. */
export const draftPrereqsOf = (task: Task): string[] =>
  (task.dependencies ?? []).filter((d) => d.status === 'draft').map((d) => d.id);

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

/** dagre depth rank per node (0 = a root with no on-canvas prerequisite). */
function computeDepths(ids: string[], edges: Array<[string, string]>): Map<string, number> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 24, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: PLAN_NODE_W, height: NODE_H });
  for (const [src, tgt] of edges) if (src !== tgt) g.setEdge(src, tgt);
  dagre.layout(g);
  // Map dagre's x coordinate (which grows with rank under LR) to a 0-based column.
  const xs = [...new Set(ids.map((id) => Math.round(g.node(id).x)))].sort((a, b) => a - b);
  const col = new Map<number, number>();
  xs.forEach((x, i) => col.set(x, i));
  const depth = new Map<string, number>();
  for (const id of ids) depth.set(id, col.get(Math.round(g.node(id).x)) ?? 0);
  return depth;
}

export interface PlanLaneData {
  kind: 'lane';
  area: string;
  count: number;
  stroke: string;
  tint: string;
  dot: string;
}

export interface PlanTaskData {
  kind: 'task';
  task: Task;
  waiting: boolean;
  stroke: string;
}

export interface PlanGraph {
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
}

/**
 * Build the React Flow node/edge graph for a set of draft tasks: one lane
 * (parent) node per area and one child node per ticket, positioned by
 * depth × lane. Parent nodes precede their children in the array, as React
 * Flow requires.
 */
export function buildPlanGraph(tasks: Task[]): PlanGraph {
  const edges = draftEdges(tasks);
  const depth = computeDepths(
    tasks.map((t) => t.id),
    edges,
  );
  const groups = groupTasksByArea(tasks); // [areaKey, tasks] busiest-first, no-area last
  const maxDepth = Math.max(0, ...[...depth.values()]);
  const contentW = CANVAS_PAD_X + LANE_PAD_X + (maxDepth + 1) * COL_W + LANE_PAD_X;
  const laneW = contentW - CANVAS_PAD_X * 2;

  const laneNodes: Node[] = [];
  const taskNodes: Node[] = [];
  let y = CANVAS_PAD_X;

  for (const [area, groupTasks] of groups) {
    // Bucket this lane's tickets by depth column, stack siblings vertically.
    const perCol = new Map<number, Task[]>();
    for (const task of groupTasks) {
      const d = depth.get(task.id) ?? 0;
      (perCol.get(d) ?? perCol.set(d, []).get(d)!).push(task);
    }
    const maxStack = Math.max(1, ...[...perCol.values()].map((c) => c.length));
    const laneHeight = LANE_PAD_TOP + maxStack * ROW_H + LANE_PAD_BOTTOM;
    const color = laneColor(area);
    const laneId = `lane:${area}`;

    laneNodes.push({
      id: laneId,
      type: 'lane',
      position: { x: CANVAS_PAD_X, y },
      draggable: false,
      selectable: false,
      focusable: false,
      data: {
        kind: 'lane',
        area,
        count: groupTasks.length,
        stroke: color.stroke,
        tint: color.tint,
        dot: color.dot,
      } satisfies PlanLaneData,
      style: { width: laneW, height: laneHeight, zIndex: 0 },
    });

    for (const [col, colTasks] of perCol) {
      colTasks.forEach((task, i) => {
        taskNodes.push({
          id: task.id,
          type: 'task',
          parentId: laneId,
          extent: 'parent',
          position: {
            x: LANE_PAD_X + col * COL_W,
            y: LANE_PAD_TOP + i * ROW_H,
          },
          data: {
            kind: 'task',
            task,
            waiting: isWaiting(task),
            stroke: color.stroke,
          } satisfies PlanTaskData,
        });
      });
    }

    y += laneHeight + LANE_GAP;
  }

  const rfEdges: Edge[] = edges.map(([src, tgt]) => ({
    id: `${src}->${tgt}`,
    source: src,
    target: tgt,
    type: 'dep',
    data: { prerequisite: src, dependent: tgt },
  }));

  return {
    nodes: [...laneNodes, ...taskNodes],
    edges: rfEdges,
    width: Math.max(contentW, 640),
    height: Math.max(y, 360),
  };
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
