import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MoreVertical, Pencil, PanelRightOpen, ArrowUpFromLine, Trash2, X } from 'lucide-react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
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
  useAddDependency,
  useDeleteTask,
  useMarkReady,
  useRemoveDependency,
  useUpdateTask,
} from '../../hooks/use-projects';
import { markSingleTaskReady } from '../v2/mark-ready-menu';
import {
  buildPlanGraph,
  cycleChain,
  draftEdges,
  type PlanLaneData,
  type PlanTaskData,
} from './plan-layout';

/**
 * The Plan-mode canvas: draft tickets as React Flow nodes inside per-area lane
 * containers, edges as dependencies. Every interaction is wired to the real
 * data layer — add/remove dependency, rename, promote, delete all hit the
 * project's existing tanstack-query hooks, and the server keeps owning the
 * same-project/self/cycle invariants. This file owns the canvas chrome and the
 * client-side pre-checks that give instant, legible feedback (the cycle flash).
 */

interface PlanActions {
  readOnly: boolean;
  busy: boolean;
  flashNodes: Set<string>;
  onRemoveDep: (prerequisite: string, dependent: string) => void;
  onPromote: (task: Task) => void;
  onDelete: (task: Task) => void;
  onRename: (task: Task, title: string) => void;
  onOpenEditor: (task: Task) => void;
}

const PlanActionsContext = createContext<PlanActions | null>(null);
const usePlanActions = () => {
  const ctx = useContext(PlanActionsContext);
  if (!ctx) throw new Error('PlanActionsContext missing');
  return ctx;
};

/** An area lane: the labelled, tinted container the tickets sit inside. */
const LaneNode = memo(function LaneNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const lane = data as unknown as PlanLaneData;
  return (
    <div
      className="pointer-events-none h-full w-full rounded-2xl border border-l-[3px]"
      style={{ background: lane.tint, borderColor: 'var(--border)', borderLeftColor: lane.stroke }}
    >
      <span
        className="absolute -top-3 left-4 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase text-muted-foreground"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="size-1.5 rounded-full" style={{ background: lane.dot }} />
        {lane.area || t(k.tasks.plan.noArea)}
        <span className="font-mono text-[10px] text-foreground/70">{lane.count}</span>
      </span>
    </div>
  );
});

/** One ticket card: code, state pill, cog menu, inline-editable title, handles. */
const TaskNode = memo(function TaskNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const actions = usePlanActions();
  const { task, waiting, stroke } = data as unknown as PlanTaskData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const flashing = actions.flashNodes.has(task.id);
  const editable = !actions.readOnly;

  const startEdit = () => {
    if (!editable) return;
    setDraft(task.title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== task.title) actions.onRename(task, next);
  };

  return (
    <div
      className={cn(
        'group/card relative w-[252px] rounded-xl border border-l-[4px] bg-card px-3.5 py-3 shadow-sm transition-shadow',
        selected && 'ring-2 ring-primary/50',
        flashing && 'animate-pulse ring-2 ring-destructive',
      )}
      style={{ borderLeftColor: flashing ? 'var(--destructive)' : waiting ? '#c07d16' : '#0a97d6' }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={editable}
        className="!size-2.5 !border-2 !bg-background"
        style={{ borderColor: 'var(--border)' }}
      />

      <div className="mb-1 flex items-center gap-1.5">
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
                aria-label={t(k.tasks.plan.cardMenu)}
                className="nodrag nopan -mr-1 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setTimeout(startEdit, 0)}>
                <Pencil className="size-4" />
                {t(k.tasks.plan.editTitle)}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.onOpenEditor(task)}>
                <PanelRightOpen className="size-4" />
                {t(k.tasks.plan.openEditor)}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-sky-700 focus:text-sky-700 dark:text-sky-300 dark:focus:text-sky-300"
                onSelect={() => actions.onPromote(task)}
              >
                <ArrowUpFromLine className="size-4" />
                {t(k.tasks.plan.promote)}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => actions.onDelete(task)}
              >
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
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="nodrag nopan w-full rounded-md border border-primary/40 bg-muted/40 px-1.5 py-1 text-[13px] font-medium outline-none"
        />
      ) : (
        <div
          className={cn('text-sm leading-snug font-medium', editable && 'cursor-text')}
          onDoubleClick={startEdit}
        >
          {task.title}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={editable}
        title={t(k.tasks.plan.linkHandle)}
        className="!size-3.5 !border-2 !bg-background hover:!scale-110"
        style={{ borderColor: stroke }}
      />
    </div>
  );
});

/** A dependency edge: dashed bezier with an arrow and a hover-revealed ✕. */
const DepEdge = memo(function DepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps) {
  const { t } = useTranslation();
  const actions = usePlanActions();
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const prerequisite = (data as { prerequisite: string }).prerequisite;
  const dependent = (data as { dependent: string }).dependent;
  const conflict = actions.flashNodes.has(prerequisite) && actions.flashNodes.has(dependent);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: conflict ? 'var(--destructive)' : 'var(--primary)',
          strokeWidth: conflict ? 2.6 : 1.8,
          strokeDasharray: conflict ? undefined : '6 5',
          opacity: 0.85,
        }}
      />
      {!actions.readOnly && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label={t(k.tasks.plan.removeDependency)}
            title={t(k.tasks.plan.removeDependency)}
            onClick={() => actions.onRemoveDep(prerequisite, dependent)}
            style={{
              // Lift above React Flow's invisible edge-interaction path (which
              // shares the viewport stacking context) so the ✕ stays clickable.
              zIndex: 10,
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            }}
            className={cn(
              'nodrag nopan pointer-events-auto absolute grid size-[22px] place-items-center rounded-full border bg-card text-destructive shadow-sm transition-opacity',
              selected ? 'opacity-100' : 'opacity-0 hover:opacity-100 focus-visible:opacity-100',
            )}
          >
            <X className="size-3" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { lane: LaneNode, task: TaskNode };
const edgeTypes = { dep: DepEdge };
const defaultEdgeOptions = {
  type: 'dep',
  markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--primary)', width: 16, height: 16 },
};

/** A stable fingerprint of the draft graph — changes drive an auto re-tidy. */
function graphSignature(tasks: Task[]): string {
  return tasks
    .map(
      (t) =>
        `${t.id}:${t.area ?? ''}:${t.status}:${t.title}:${(t.dependencies ?? [])
          .map((d) => `${d.id}/${d.status}`)
          .join(',')}`,
    )
    .sort()
    .join('|');
}

export interface PlanCanvasProps {
  draftTasks: Task[];
  readOnly: boolean;
  /** Jump back to the board with this ticket's full editor open. */
  onOpenEditor: (task: Task) => void;
  /** Imperatively re-run the layout (the Tidy button). */
  registerTidy: (tidy: () => void) => void;
}

export function PlanCanvas({
  draftTasks,
  readOnly,
  onOpenEditor,
  registerTidy,
}: PlanCanvasProps) {
  const { t } = useTranslation();
  const { fitView } = useReactFlow();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const markReady = useMarkReady();
  // The promote-with-prerequisites confirm: a ticket that still waits on draft
  // prerequisites offers to promote that chain too (the mark-ready cascade).
  const [promoteTarget, setPromoteTarget] = useState<{ task: Task; count: number } | null>(null);

  const signature = useMemo(() => graphSignature(draftTasks), [draftTasks]);
  const graph = useMemo(() => buildPlanGraph(draftTasks), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const edgePairs = useMemo(() => draftEdges(draftTasks), [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const [flashNodes, setFlashNodes] = useState<Set<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-tidy: any structural change to the draft graph re-lays-out the canvas
  // AND refits the viewport, so the content stays centred and filling the frame
  // (never marooned in a corner) after every add/remove/promote/create.
  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    const raf = requestAnimationFrame(() => void fitView({ duration: 300, padding: 0.18, maxZoom: 1 }));
    return () => cancelAnimationFrame(raf);
  }, [graph, setNodes, setEdges, fitView]);

  useEffect(() => {
    registerTidy(() => {
      setNodes(graph.nodes);
      setEdges(graph.edges);
      requestAnimationFrame(() => void fitView({ duration: 320, padding: 0.18, maxZoom: 1 }));
    });
  }, [graph, registerTidy, setNodes, setEdges, fitView]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const flashChain = useCallback((ids: string[]) => {
    setFlashNodes(new Set(ids));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashNodes(new Set()), 1100);
  }, []);

  const busy =
    addDependency.isLoading ||
    removeDependency.isLoading ||
    updateTask.isLoading ||
    deleteTask.isLoading ||
    markReady.isLoading;

  const onConnect = useCallback(
    (conn: Connection | Edge) => {
      const prerequisite = conn.source;
      const dependent = conn.target;
      if (!prerequisite || !dependent) return;
      if (prerequisite === dependent) {
        flashChain([prerequisite]);
        toast.error(t(k.tasks.plan.rejectSelf));
        return;
      }
      if (edgePairs.some(([p, d]) => p === prerequisite && d === dependent)) {
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
      // Legal by client pre-check — the server still enforces the invariants.
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

  const onRemoveDep = useCallback(
    (prerequisite: string, dependent: string) => {
      void removeDependency
        .execute({ id: dependent, dependsOnTaskId: prerequisite })
        .then((res) => {
          if (res.e) toast.error(t(res.e.message));
        });
    },
    [removeDependency, t],
  );

  const onRename = useCallback(
    (task: Task, title: string) => {
      void updateTask.execute({ id: task.id, title }).then((res) => {
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
      // Unmet DRAFT prerequisites are the ones the cascade will pull in — offer
      // it. A clear (or done-prereq) ticket promotes straight away.
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

  const actions = useMemo<PlanActions>(
    () => ({
      readOnly,
      busy,
      flashNodes,
      onRemoveDep,
      onPromote,
      onDelete,
      onRename,
      onOpenEditor,
    }),
    [readOnly, busy, flashNodes, onRemoveDep, onPromote, onDelete, onRename, onOpenEditor],
  );

  return (
    <PlanActionsContext.Provider value={actions}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        elementsSelectable
        // Touch: one-finger drag pans the pane, two-finger pinch zooms; React
        // Flow already preventDefaults inside the pane so the page never
        // scroll-jacks. A generous connectionRadius makes finger-linking forgiving.
        panOnDrag
        zoomOnPinch
        panOnScroll={false}
        connectionRadius={38}
        minZoom={0.2}
        maxZoom={1.75}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        className="bg-muted/20"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} />
        {/* plan-controls: enlarged to finger size on touch (see index.css). */}
        <Controls showInteractive={false} className="plan-controls !shadow-sm" />
      </ReactFlow>

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
    </PlanActionsContext.Provider>
  );
}
