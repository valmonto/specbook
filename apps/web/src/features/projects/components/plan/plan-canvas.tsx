import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowUpFromLine,
  Check,
  Lock,
  MoreVertical,
  PanelRightOpen,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { useIsMobile } from '@/shared/hooks/use-mobile';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  CARD_H,
  PLAN_NODE_W,
  blockersOf,
  buildPlanLayout,
  clampToLane,
  cycleChain,
  draftEdges,
  edgeMid,
  edgePath,
  edgePoints,
  isWaiting,
  tempLinkPath,
  unlocksOf,
  type LaneRect,
  type PlanPoint,
} from './plan-layout';
import {
  useAddDependency,
  useDeleteTask,
  useMarkReady,
  useRemoveDependency,
  useUpdateTask,
} from '../../hooks/use-projects';
import { markSingleTaskReady } from '../v2/mark-ready-menu';

/**
 * Plan — the hand-rolled dependency canvas (no React Flow, no dagre). Ported
 * from the reference mockup's engine: absolutely-positioned cards inside a
 * scrollable canvas, per-area lane containers a card can't be dragged out of,
 * depth × lane auto-layout that re-tidies on every change, drag-from-handle to
 * link, a hover ✕ at each edge midpoint to unlink, a per-card cog menu, and a
 * transient red flash when a link would self/duplicate/cycle. Every mutation
 * goes through the real project hooks, so the server keeps enforcing the
 * same-project / self / cycle invariants.
 */

const signatureOf = (tasks: Task[]): string =>
  tasks
    .map(
      (t) =>
        `${t.id}:${t.area ?? ''}:${t.status}:${t.title}:${(t.dependencies ?? [])
          .map((d) => `${d.id}/${d.status}`)
          .join(',')}`,
    )
    .sort()
    .join('|');

const areaKeyOf = (task: Task): string => task.area?.trim() ?? '';

interface FlashState {
  nodes: Set<string>;
  edges: Set<string>;
}

export interface PlanCanvasProps {
  draftTasks: Task[];
  readOnly: boolean;
  onOpenEditor: (task: Task) => void;
  registerTidy: (tidy: () => void) => void;
}

export function PlanCanvas({
  draftTasks,
  readOnly,
  onOpenEditor,
  registerTidy,
}: PlanCanvasProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const markReady = useMarkReady();

  const signature = useMemo(() => signatureOf(draftTasks), [draftTasks]);
  // Measured card heights (see the layout effect below) feed straight back into
  // the layout so cards stack by their REAL height and can never overlap. Kept
  // above the layout memo because the memo now reads it.
  const [heights, setHeights] = useState<Record<string, number>>({});
  // Phones get the compact layout (tighter gutter, roomier gaps, larger lane
  // containers, fits-to-width by default); switching pointer class re-tidies,
  // which is the desired feel.
  const layout = useMemo(
    () => buildPlanLayout(draftTasks, { compact: isMobile, heights }),
    [signature, isMobile, heights], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const edgePairs = useMemo(() => draftEdges(draftTasks), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const laneByArea = useMemo(() => {
    const m = new Map<string, LaneRect>();
    for (const lane of layout.lanes) m.set(lane.area, lane);
    return m;
  }, [layout]);

  // Absolute card positions. The layout is the source of truth: any structural
  // change recomputes it and re-tidies (positions reset). A manual drag mutates
  // this until the next structural change re-tidies — exactly the mockup's feel.
  const [positions, setPositions] = useState<Record<string, PlanPoint>>(layout.positions);
  // useLayoutEffect (not useEffect): once the measure pass feeds real heights
  // into the layout, re-seat the cards BEFORE paint so the corrected, collision-
  // free positions are what the user first sees (no one-frame overlap flash).
  useLayoutEffect(() => setPositions(layout.positions), [layout]);
  // The tidy layout, readable from the window-level drag-end handler without
  // re-binding it every render — used to snap a card back when a drop would
  // overlap another card.
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [tempPath, setTempPath] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashState>({ nodes: new Set(), edges: new Set() });
  const [promoteTarget, setPromoteTarget] = useState<{ task: Task; count: number } | null>(null);

  const cvsRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  );
  const editable = !readOnly;
  const editing = editingId;

  // Measure real card heights so edges anchor at the true vertical centre.
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    for (const task of draftTasks) {
      const el = nodeRefs.current.get(task.id);
      if (el) next[task.id] = el.offsetHeight;
    }
    setHeights((prev) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length && keys.every((key) => prev[key] === next[key]))
        return prev;
      return next;
    });
  }, [signature, editing, draftTasks]);

  const cardHeight = useCallback((id: string) => heights[id] ?? CARD_H, [heights]);

  useEffect(() => {
    registerTidy(() => setPositions({ ...layout.positions }));
  }, [layout, registerTidy]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const flashChain = useCallback(
    (ids: string[]) => {
      const nodes = new Set(ids);
      const edges = new Set<string>();
      for (let i = 0; i < ids.length - 1; i++) {
        const key = `${ids[i]}>${ids[i + 1]}`;
        if (edgePairs.some(([b, d]) => `${b}>${d}` === key)) edges.add(key);
      }
      setFlash({ nodes, edges });
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash({ nodes: new Set(), edges: new Set() }), 1200);
    },
    [edgePairs],
  );

  // ---- mutations (all through the real hooks) ----
  const addDep = useCallback(
    (prerequisite: string, dependent: string) => {
      if (prerequisite === dependent) {
        flashChain([prerequisite]);
        toast.error(t(k.tasks.plan.rejectSelf));
        return;
      }
      if (edgePairs.some(([b, d]) => b === prerequisite && d === dependent)) {
        flashChain([prerequisite, dependent]);
        toast.error(t(k.tasks.plan.rejectDuplicate));
        return;
      }
      const chain = cycleChain(edgePairs, prerequisite, dependent);
      if (chain) {
        flashChain(chain);
        toast.error(t(k.tasks.plan.rejectCycle));
        return;
      }
      void addDependency
        .execute({ id: dependent, dependsOnTaskId: prerequisite })
        .then((res) => {
          if (res.e) {
            flashChain([prerequisite, dependent]);
            toast.error(t(res.e.message));
          }
        });
    },
    [addDependency, edgePairs, flashChain, t],
  );

  const removeDep = useCallback(
    (prerequisite: string, dependent: string) => {
      void removeDependency
        .execute({ id: dependent, dependsOnTaskId: prerequisite })
        .then((res) => {
          if (res.e) toast.error(t(res.e.message));
        });
    },
    [removeDependency, t],
  );

  const renameTask = useCallback(
    (task: Task, title: string) => {
      const next = title.trim();
      if (!next || next === task.title) return;
      void updateTask.execute({ id: task.id, title: next }).then((res) => {
        if (res.e) toast.error(t(res.e.message));
      });
    },
    [updateTask, t],
  );

  const promoteNow = useCallback(
    (task: Task) => void markSingleTaskReady(markReady, task, t),
    [markReady, t],
  );

  const onPromote = useCallback(
    (task: Task) => {
      const chain = (task.dependencies ?? []).filter((d) => d.status === 'draft');
      if (chain.length > 0) setPromoteTarget({ task, count: chain.length });
      else void promoteNow(task);
    },
    [promoteNow],
  );

  const onDelete = useCallback(
    (task: Task) => {
      void deleteTask.execute({ id: task.id }).then((res) => {
        if (res.e) toast.error(t(res.e.message));
      });
    },
    [deleteTask, t],
  );

  // ---- drag a card (clamped to its lane) ----
  const onNodePointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (!editable) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-handle]') || target.closest('[data-cog]') || target.closest('input'))
      return;
    setSelectedId(id);
    const pos = positions[id];
    if (!pos) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    setDraggingId(id);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp, { once: true });
    e.preventDefault();
  };
  const onDragMove = useCallback((e: globalThis.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    let nx = drag.ox + (e.clientX - drag.sx);
    let ny = drag.oy + (e.clientY - drag.sy);
    setPositions((prev) => {
      const task = drag.id;
      const el = nodeRefs.current.get(task);
      const ch = el?.offsetHeight ?? CARD_H;
      const area = laneByAreaRef.current.get(areaOfRef.current.get(task) ?? '');
      if (area) {
        const clamped = clampToLane(area, nx, ny, ch);
        nx = clamped.x;
        ny = clamped.y;
      }
      return { ...prev, [task]: { x: nx, y: ny } };
    });
  }, []);
  const onDragUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    window.removeEventListener('pointermove', onDragMove);
    if (!drag) return;
    const id = drag.id;
    // Collision detection: a card may be nudged freely, but a drop that leaves
    // it overlapping another card snaps it back to its tidy layout slot — so the
    // board can never end up with cards stacked on top of each other.
    setPositions((prev) => {
      const me = prev[id];
      if (!me) return prev;
      const hOf = (nid: string) => nodeRefs.current.get(nid)?.offsetHeight ?? CARD_H;
      const mh = hOf(id);
      const overlaps = Object.entries(prev).some(([oid, op]) => {
        if (oid === id) return false;
        return (
          me.x < op.x + PLAN_NODE_W &&
          me.x + PLAN_NODE_W > op.x &&
          me.y < op.y + hOf(oid) &&
          me.y + mh > op.y
        );
      });
      if (!overlaps) return prev;
      const tidy = layoutRef.current.positions[id];
      return tidy ? { ...prev, [id]: tidy } : prev;
    });
  }, [onDragMove]);

  // Refs the window-level drag handler reads without being re-bound each render.
  const laneByAreaRef = useRef(laneByArea);
  const areaOfRef = useRef(new Map<string, string>());
  useEffect(() => {
    laneByAreaRef.current = laneByArea;
    const m = new Map<string, string>();
    for (const task of draftTasks) m.set(task.id, areaKeyOf(task));
    areaOfRef.current = m;
  }, [laneByArea, draftTasks]);

  // ---- drag a link from the ○ handle ----
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    setLinkFrom(id);
    window.addEventListener('pointermove', onLinkMove);
    window.addEventListener('pointerup', onLinkUp, { once: true });
  };
  const linkFromRef = useRef<string | null>(null);
  useEffect(() => {
    linkFromRef.current = linkFrom;
  }, [linkFrom]);
  const onLinkMove = useCallback((e: globalThis.PointerEvent) => {
    const from = linkFromRef.current;
    if (!from) return;
    const rect = cvsRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    const fromPos = positionsRef.current[from];
    if (!fromPos) return;
    const fromH = nodeRefs.current.get(from)?.offsetHeight ?? CARD_H;
    setTempPath(tempLinkPath(fromPos, fromH, px, py));
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const node = under?.closest('[data-node-id]') as HTMLElement | null;
    const overId = node?.getAttribute('data-node-id') ?? null;
    setDropTargetId(overId && overId !== from ? overId : null);
  }, []);
  const onLinkUp = useCallback((e: globalThis.PointerEvent) => {
    const from = linkFromRef.current;
    setTempPath(null);
    setDropTargetId(null);
    setLinkFrom(null);
    window.removeEventListener('pointermove', onLinkMove);
    if (!from) return;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const node = under?.closest('[data-node-id]') as HTMLElement | null;
    const overId = node?.getAttribute('data-node-id') ?? null;
    if (overId && overId !== from) addDepRef.current(from, overId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);
  const addDepRef = useRef(addDep);
  useEffect(() => {
    addDepRef.current = addDep;
  }, [addDep]);

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointermove', onLinkMove);
    },
    [onDragMove, onLinkMove],
  );

  const setNodeRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      nodeRefs.current.set(id, el);
    },
    [],
  );

  return (
    <div
      className={cn(
        'relative h-full w-full overflow-auto bg-muted/20',
        linkFrom && 'cursor-crosshair',
      )}
      style={{
        backgroundImage:
          'radial-gradient(circle at 1px 1px, var(--border) 1.2px, transparent 0)',
        backgroundSize: '22px 22px',
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null);
      }}
    >
      <div
        ref={cvsRef}
        className="relative"
        style={{ width: layout.width, height: layout.height }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setSelectedId(null);
        }}
      >
        {/* Area lanes: labelled, tinted containers cards are clamped inside. */}
        {layout.lanes.map((lane) => (
          <div
            key={`lane:${lane.area}`}
            className="pointer-events-none absolute rounded-2xl border border-l-[3px]"
            style={{
              left: lane.left,
              top: lane.top,
              width: lane.width,
              height: lane.height,
              background: lane.color.tint,
              borderColor: 'var(--border)',
              borderLeftColor: lane.color.stroke,
            }}
          >
            <span
              className="absolute -top-3 left-4 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase text-muted-foreground"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="size-1.5 rounded-full" style={{ background: lane.color.dot }} />
              {lane.area || t(k.tasks.plan.noArea)}
              <span className="font-mono text-[10px] text-foreground/70">{lane.count}</span>
            </span>
          </div>
        ))}

        {/* Dependency edges (SVG cubic beziers) + the live drag link. */}
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker
              id="plan-arrow"
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="var(--primary)" />
            </marker>
            <marker
              id="plan-arrow-flash"
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="var(--destructive)" />
            </marker>
          </defs>
          {edgePairs.map(([b, d]) => {
            const from = positions[b];
            const to = positions[d];
            if (!from || !to) return null;
            const key = `${b}>${d}`;
            const pts = edgePoints(from, to, cardHeight(b), cardHeight(d));
            const path = edgePath(pts);
            const conflict = flash.edges.has(key);
            const hot = hoveredEdge === key;
            return (
              <g key={key}>
                {editable && (
                  <path
                    d={path}
                    fill="none"
                    stroke="transparent"
                    // Fatter, easier-to-tap hit line on touch.
                    strokeWidth={isMobile ? 28 : 16}
                    className="pointer-events-auto cursor-pointer"
                    onMouseEnter={() => setHoveredEdge(key)}
                    onMouseLeave={() => setHoveredEdge((cur) => (cur === key ? null : cur))}
                    onClick={() => removeDep(b, d)}
                  />
                )}
                <path
                  d={path}
                  fill="none"
                  markerEnd={`url(#${conflict ? 'plan-arrow-flash' : 'plan-arrow'})`}
                  style={{
                    stroke: conflict ? 'var(--destructive)' : 'var(--primary)',
                    strokeWidth: conflict || hot ? 3.2 : 1.9,
                    strokeDasharray: conflict ? undefined : '6 5',
                    opacity: 0.85,
                  }}
                  className="transition-[stroke-width]"
                />
              </g>
            );
          })}
          {tempPath && (
            <path
              d={tempPath}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={2.5}
              strokeDasharray="4 4"
            />
          )}
        </svg>

        {/* The hover-revealed ✕ at each edge midpoint. */}
        {editable &&
          edgePairs.map(([b, d]) => {
            const from = positions[b];
            const to = positions[d];
            if (!from || !to) return null;
            const key = `${b}>${d}`;
            const mid = edgeMid(edgePoints(from, to, cardHeight(b), cardHeight(d)));
            // Touch has no hover, so the ✕ stays visible (and larger) on phones.
            const show = hoveredEdge === key || isMobile;
            return (
              <button
                key={`x:${key}`}
                type="button"
                aria-label={t(k.tasks.plan.removeDependency)}
                title={t(k.tasks.plan.removeDependency)}
                onMouseEnter={() => setHoveredEdge(key)}
                onMouseLeave={() => setHoveredEdge((cur) => (cur === key ? null : cur))}
                onClick={() => removeDep(b, d)}
                style={{ left: mid.x, top: mid.y, touchAction: 'none' }}
                className={cn(
                  'absolute z-30 grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border bg-card text-destructive shadow-sm transition-opacity',
                  isMobile && 'size-[32px]',
                  show ? 'opacity-100' : 'pointer-events-none opacity-0',
                )}
              >
                <X className={cn('size-3', isMobile && 'size-4')} />
              </button>
            );
          })}

        {/* Ticket cards. */}
        {draftTasks.map((task) => {
          const pos = positions[task.id];
          if (!pos) return null;
          const waiting = isWaiting(task);
          const blockers = blockersOf(edgePairs, task.id).length;
          const unlocks = unlocksOf(edgePairs, task.id).length;
          const flashing = flash.nodes.has(task.id);
          const isDrop = dropTargetId === task.id;
          return (
            <TaskCard
              key={task.id}
              ref={setNodeRef(task.id)}
              task={task}
              pos={pos}
              isMobile={isMobile}
              waiting={waiting}
              blockers={blockers}
              unlocks={unlocks}
              selected={selectedId === task.id}
              dragging={draggingId === task.id}
              flashing={flashing}
              dropTarget={isDrop}
              linking={linkFrom !== null}
              editable={editable}
              editing={editingId === task.id}
              onStartEdit={() => setEditingId(task.id)}
              onCommitEdit={(title) => {
                setEditingId(null);
                renameTask(task, title);
              }}
              onCancelEdit={() => setEditingId(null)}
              onPointerDown={(e) => onNodePointerDown(e, task.id)}
              onHandlePointerDown={(e) => onHandlePointerDown(e, task.id)}
              onOpenEditor={() => onOpenEditor(task)}
              onPromote={() => onPromote(task)}
              onDelete={() => onDelete(task)}
            />
          );
        })}
      </div>

      <AlertDialog
        open={promoteTarget !== null}
        onOpenChange={(open) => !open && setPromoteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.tasks.plan.promoteChainTitle)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(k.tasks.plan.promoteChainBody, { count: promoteTarget?.count ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={markReady.isLoading}
              onClick={() => {
                const target = promoteTarget?.task;
                setPromoteTarget(null);
                if (target) void promoteNow(target);
              }}
            >
              {t(k.tasks.markReady.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  pos: PlanPoint;
  isMobile: boolean;
  waiting: boolean;
  blockers: number;
  unlocks: number;
  selected: boolean;
  dragging: boolean;
  flashing: boolean;
  dropTarget: boolean;
  linking: boolean;
  editable: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCommitEdit: (title: string) => void;
  onCancelEdit: () => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onHandlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenEditor: () => void;
  onPromote: () => void;
  onDelete: () => void;
}

const TaskCard = ({
  ref,
  task,
  pos,
  isMobile,
  waiting,
  blockers,
  unlocks,
  selected,
  dragging,
  flashing,
  dropTarget,
  linking,
  editable,
  editing,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onPointerDown,
  onHandlePointerDown,
  onOpenEditor,
  onPromote,
  onDelete,
}: TaskCardProps & { ref: Ref<HTMLDivElement> }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(task.title);
  useEffect(() => {
    if (editing) setDraft(task.title);
  }, [editing, task.title]);

  return (
    <div
      ref={ref}
      data-node-id={task.id}
      onPointerDown={onPointerDown}
      style={{
        left: pos.x,
        top: pos.y,
        width: PLAN_NODE_W,
        borderLeftColor: flashing ? 'var(--destructive)' : waiting ? '#c07d16' : '#0a97d6',
        transition: dragging ? 'none' : 'left .28s cubic-bezier(.22,.61,.36,1), top .28s cubic-bezier(.22,.61,.36,1), box-shadow .15s',
        // Never let a touch-drag of a card scroll the canvas underneath it;
        // one-finger drags on empty space still pan (native scroll).
        touchAction: 'none',
      }}
      className={cn(
        'group/card absolute rounded-xl border border-l-[4px] bg-card px-3 py-2.5 shadow-sm select-none',
        editable && !linking && 'cursor-grab',
        dragging && 'z-20 cursor-grabbing shadow-lg',
        selected && 'ring-2 ring-primary/50',
        dropTarget && 'ring-2 ring-primary',
        flashing && 'ring-2 ring-destructive',
        linking && 'cursor-pointer',
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="truncate font-mono text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {(task.area?.trim() || t(k.tasks.plan.noArea)) + ' · #' + task.id.slice(-4)}
        </span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            waiting
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              : 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
          )}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {t(waiting ? k.tasks.plan.waiting : k.tasks.plan.clear)}
        </span>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-cog
                aria-label={t(k.tasks.plan.cardMenu)}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  '-mr-1 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
                  isMobile && 'size-9',
                )}
              >
                <MoreVertical className={cn('size-4', isMobile && 'size-5')} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setTimeout(onStartEdit, 0)}>
                <Pencil className="size-4" />
                {t(k.tasks.plan.editTitle)}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenEditor}>
                <PanelRightOpen className="size-4" />
                {t(k.tasks.plan.openEditor)}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-sky-700 focus:text-sky-700 dark:text-sky-300 dark:focus:text-sky-300"
                onSelect={onPromote}
              >
                <ArrowUpFromLine className="size-4" />
                {t(k.tasks.plan.promote)}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
                <Trash2 className="size-4" />
                {t(k.tasks.plan.deleteDraft)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {editing ? (
        <input
          autoFocus
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => onCommitEdit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') onCancelEdit();
          }}
          className="w-full rounded-md border border-primary/40 bg-muted/40 px-1.5 py-1 text-[13px] font-medium outline-none"
        />
      ) : (
        <div
          // Wrap + clamp to 3 lines with an ellipsis so a long title (or an
          // unbroken token like `systemRole=ADMIN`) never clips or spills past
          // the card's fixed width — it wraps, and the card grows to fit (bounded
          // at 3 lines), which the layout then stacks around by measured height.
          className={cn(
            'text-[13px] leading-snug font-medium break-words hyphens-auto line-clamp-3 [overflow-wrap:anywhere]',
            editable && 'cursor-text',
          )}
          title={task.title}
          onDoubleClick={() => editable && onStartEdit()}
        >
          {task.title}
        </div>
      )}

      <div className="mt-2 flex min-h-[15px] items-center gap-1.5 text-[11px] text-muted-foreground">
        {waiting ? (
          <>
            <Lock className="size-3" />
            {t(k.tasks.plan.waitingLegend)}
            {blockers > 1 ? ` · ${blockers}` : ''}
          </>
        ) : (
          <>
            <Check className="size-3" />
            {unlocks > 0 ? `${t(k.tasks.plan.clear)} · unlocks ${unlocks}` : t(k.tasks.plan.clear)}
          </>
        )}
      </div>

      {editable && (
        <div
          data-handle
          title={t(k.tasks.plan.linkHandle)}
          onPointerDown={onHandlePointerDown}
          className={cn(
            'absolute top-1/2 grid -translate-y-1/2 cursor-crosshair place-items-center rounded-full border-2 bg-background transition-transform hover:scale-125',
            // A comfortably-tappable target on touch; the desktop dot is unchanged.
            isMobile ? '-right-[16px] size-[32px]' : '-right-[9px] size-[18px]',
          )}
          // touch-action:none so grabbing the handle drags a link, not the page.
          style={{ borderColor: waiting ? '#c07d16' : '#0a97d6', touchAction: 'none' }}
        >
          <span
            className={cn('rounded-full', isMobile ? 'size-2.5' : 'size-1.5')}
            style={{ background: waiting ? '#c07d16' : '#0a97d6' }}
          />
        </div>
      )}
    </div>
  );
};
