import { createContext, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  FlaskConical,
  GitMerge,
  Hourglass,
  Loader2,
  ListChecks,
  MoreHorizontal,
  Tag,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import type { Task, TaskDependencyInfo, TaskStatus } from '@pkg/contracts';
import { TERMINAL_TASK_STATUSES } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { StatusBadge } from '../status-badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useDeleteTask,
  useMarkReady,
  useMergeTask,
  useTransitionTask,
  useUpdateTask,
} from '../../hooks/use-projects';
import { useProjectReadOnly } from './read-only-context';
import { markSingleTaskReady } from './mark-ready-menu';
import { TaskDetail, type TaskDetailProps } from '../task-detail';
import { CancelTaskDialog, liveDependents } from '../cancel-task-dialog';

/**
 * The v2 task rows: an accordion where the EXPANDED ROW IS the task detail.
 * The detail body itself is the shared <TaskDetail>, so the board and the
 * "Your move" slide-over render the exact same thing; this file only owns the
 * board's row chrome — the collapsed line, its overflow menu, and (on the
 * approved stage) the one-click merge that stays reachable without expanding.
 */

export interface CardProps {
  task: Task;
  expanded: boolean;
  /** Just created via "+ New task": the row mounts with its title in edit mode. */
  freshlyCreated?: boolean;
  /** Expand/collapse this card (the page enforces one-at-a-time). */
  onToggle: (id: string) => void;
}

const isTerminal = (task: Task) => task.status === 'done' || task.status === 'cancelled';

/** "2h" / "3d" — magnitude, not clocks (same idiom as the dashboard). */
const ago = (iso: string | null): string => {
  if (!iso) return '';
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const prChipStyles: Record<NonNullable<Task['prState']>, string> = {
  open: 'text-emerald-600 dark:text-emerald-400',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-rose-600 dark:text-rose-400',
};

/** Linear-style compact PR marker: colored icon + number, words in the tooltip. */
function PrChip({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.prState) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-xs tabular-nums',
        prChipStyles[task.prState],
      )}
      title={t(k.tasks.prState[task.prState])}
    >
      <GitMerge className="size-3.5" />
      {task.prNumber ? `#${task.prNumber}` : ''}
    </span>
  );
}

const ciDotStyles: Record<NonNullable<Task['ciState']>, string> = {
  pending: 'bg-amber-400 animate-pulse',
  passing: 'bg-emerald-500',
  failing: 'bg-rose-500',
};

/**
 * Lineage: a quiet "from · <research title>" chip linking back to the research
 * document a ticket was cut from. Shown only when the read path resolved the
 * source title; it's provenance, not a primary action, so it stays subtle.
 */
function FromResearchChip({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.sourceResearchId || !task.sourceResearchTitle) return null;
  return (
    <Link
      to={`/research/${task.sourceResearchId}`}
      onClick={(e) => e.stopPropagation()}
      title={task.sourceResearchTitle}
      className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground hover:underline"
    >
      <FlaskConical className="size-3 shrink-0" />
      <span className="shrink-0">{t(k.tasks.v2.fromResearch)}</span>
      <span aria-hidden className="shrink-0">·</span>
      <span className="max-w-[10rem] truncate">{task.sourceResearchTitle}</span>
    </Link>
  );
}

/**
 * When the board groups by area, each row wears its area as a quiet chip
 * (the group header already names it, but the chip keeps the label with the
 * row as it scrolls). Off by default so Status mode renders exactly as before.
 */
export const ShowAreaChipContext = createContext(false);

function AreaChip({ task }: { task: Task }) {
  const show = useContext(ShowAreaChipContext);
  if (!show || !task.area) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground">
      <Tag className="size-3 shrink-0" />
      <span className="max-w-[10rem] truncate">{task.area}</span>
    </span>
  );
}

/**
 * The assumption flag: a quiet amber chip marking a task the agent shipped on a
 * reversible judgment call. Its presence is why the task is held out of
 * full-auto's auto-merge, so it reads as "needs a human look" on the row — the
 * `what` sits in the tooltip; the full record is in the expanded detail.
 */
function AssumptionChip({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.assumptionFlag) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-amber-700 ring-1 ring-amber-500/20 ring-inset dark:text-amber-300"
      title={task.assumptionFlag.what}
    >
      <TriangleAlert className="size-3 shrink-0" />
      {t(k.tasks.assumption.chip)}
    </span>
  );
}

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

/** One chip in the dependency indicator: an icon + count that reveals the
 *  actual edges (status badge + title) in a tooltip on hover/focus. */
function EdgeChip({
  icon: Icon,
  label,
  heading,
  edges,
  muted,
}: {
  icon: typeof ArrowDownToLine;
  label: string;
  heading: string;
  edges: TaskDependencyInfo[];
  muted?: boolean;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums outline-none ring-1 ring-inset transition-colors',
              muted
                ? 'bg-muted text-muted-foreground/80 ring-transparent'
                : 'text-muted-foreground ring-transparent hover:bg-muted focus-visible:bg-muted',
            )}
          >
            <Icon className="size-3 shrink-0" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="mb-1 font-medium">{heading}</p>
          <ul className="space-y-1">
            {edges.map((e) => (
              <li key={e.id} className="flex items-center gap-1.5">
                <StatusBadge status={e.status} className="shrink-0" />
                <span className="truncate">{e.title}</span>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The collapsed row's dependency indicator: glanceable sequencing without
 * opening the detail. Renders ONLY when the task actually has edges, so
 * dependency-free rows stay quiet.
 * - "depends on N" — prerequisites; when some aren't terminal yet the chip
 *   becomes a muted "waiting on M" (its blockers can't be picked up yet).
 *   This is deliberately separate from the `blocked` STATUS (human-clarification).
 * - "blocks N" — the reverse edge (tasks waiting on this one).
 * Each chip's tooltip lists WHICH tasks, so the chain is traceable inline.
 */
function DependencyIndicator({ task }: { task: Task }) {
  const { t } = useTranslation();
  const dependencies = task.dependencies ?? [];
  const dependents = task.dependents ?? [];
  if (dependencies.length === 0 && dependents.length === 0) return null;

  const unfinished = dependencies.filter((d) => !TERMINAL.has(d.status));
  const waiting = unfinished.length > 0;

  return (
    <span className="hidden items-center gap-1.5 sm:inline-flex">
      {dependencies.length > 0 &&
        (waiting ? (
          <EdgeChip
            icon={Hourglass}
            muted
            label={t(k.tasks.v2.waitingOn, { n: unfinished.length })}
            heading={t(k.tasks.v2.waitingHeading)}
            edges={dependencies}
          />
        ) : (
          <EdgeChip
            icon={ArrowDownToLine}
            label={t(k.tasks.v2.dependsOn, { n: dependencies.length })}
            heading={t(k.tasks.detail.dependencies)}
            edges={dependencies}
          />
        ))}
      {dependents.length > 0 && (
        <EdgeChip
          icon={ArrowUpFromLine}
          label={t(k.tasks.v2.blocks, { n: dependents.length })}
          heading={t(k.tasks.detail.dependents)}
          edges={dependents}
        />
      )}
    </span>
  );
}

/** The stage-specific card component for a task's status (mixed in Area mode). */
export function cardFor(status: TaskStatus): (props: CardProps) => React.JSX.Element {
  return status === 'needs_review'
    ? ReviewCard
    : status === 'approved'
      ? ApprovedCard
      : status === 'blocked'
        ? BlockedCard
        : PlainCard;
}

/** CI as a bare dot — the words live in the tooltip. */
function CiDot({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.ciState) return null;
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', ciDotStyles[task.ciState])}
      title={t(k.tasks.ciState[task.ciState])}
    />
  );
}

/**
 * The row's overflow menu — the stage's legal moves reachable WITHOUT
 * expanding: dispatch, requeue, claim reset, cancel, draft delete. Hidden
 * for terminal tasks (no moves) and revealed on row hover/focus, at the far
 * right — same icon whether the row is collapsed or expanded.
 */
function RowMenu({ task }: { task: Task }) {
  const readOnly = useProjectReadOnly();
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const markReady = useMarkReady();
  const deleteTask = useDeleteTask();
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (readOnly || isTerminal(task)) return null;

  const go = async (to: 'ready' | 'draft' | 'cancelled') => {
    // Dispatching a draft is the cascade path: mark-ready also promotes the
    // task's transitive draft prerequisites and reports any it pulled in, so a
    // task is never left ready-but-stranded. Direct action, no confirmation.
    if (to === 'ready' && task.status === 'draft') {
      await markSingleTaskReady(markReady, task, t);
      return;
    }
    const res = await transition.execute({ id: task.id, to });
    if (res.e) toast.error(t(res.e.message));
  };

  // Cancelling a task with LIVE dependents severs those edges — warn and list
  // them first; with none, cancel outright.
  const cancelDependents = liveDependents(task);
  const requestCancel = () => {
    if (cancelDependents.length > 0) setConfirmCancel(true);
    else void go('cancelled');
  };
  const busy = transition.isLoading || markReady.isLoading || deleteTask.isLoading;
  const dispatchBlocked =
    task.status === 'draft' && (!task.context?.trim() || task.acceptanceCriteria.length === 0);

  const moves: Array<{ labelKey: string; to: 'ready' | 'draft'; disabled?: boolean; hint?: string }> = [];
  if (task.status === 'draft')
    moves.push({
      labelKey: k.tasks.actions.markReady,
      to: 'ready',
      disabled: dispatchBlocked,
      hint: dispatchBlocked ? t(k.tasks.errors.dispatchGate) : undefined,
    });
  if (task.status === 'ready') moves.push({ labelKey: k.tasks.actions.backToDraft, to: 'draft' });
  if (task.status === 'in_progress')
    moves.push({ labelKey: k.tasks.actions.resetClaim, to: 'ready' });
  if (task.status === 'changes_requested')
    moves.push({ labelKey: k.tasks.actions.markReady, to: 'ready' });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={t(k.tasks.actions.cancelTask)}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {moves.map((m) => (
            <DropdownMenuItem
              key={m.labelKey}
              disabled={busy || m.disabled}
              title={m.hint}
              onClick={() => void go(m.to)}
            >
              {t(m.labelKey)}
            </DropdownMenuItem>
          ))}
          {task.status === 'draft' && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={busy}
              onClick={() => void deleteTask.execute({ id: task.id })}
            >
              {t(k.tasks.actions.deleteDraft)}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={busy} onClick={requestCancel}>
            {t(k.tasks.actions.cancelTask)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CancelTaskDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        dependents={cancelDependents}
        isLoading={transition.isLoading}
        onConfirm={() => {
          setConfirmCancel(false);
          void go('cancelled');
        }}
      />
    </>
  );
}

/**
 * A list row, not a card: the page wraps rows in ONE bordered container with
 * hairline dividers. Collapsed, clicking the title toggles; expanded, the
 * title becomes click-to-rename (the chevron keeps toggling).
 */
function CardShell({
  task,
  expanded,
  freshlyCreated,
  onToggle,
  children,
  actions,
}: CardProps & { children?: React.ReactNode; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  // A fresh "Untitled" draft mounts straight into renaming.
  const readOnly = useProjectReadOnly();
  const [editingTitle, setEditingTitle] = useState(Boolean(freshlyCreated) && !readOnly);
  const [titleDraft, setTitleDraft] = useState(freshlyCreated ? task.title : '');
  // Optimistic: show the saved value immediately; server truth replaces it
  // on revalidation (or an error reverts it) — no old-value flash.
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);
  useEffect(() => {
    if (optimisticTitle !== null && task.title === optimisticTitle) setOptimisticTitle(null);
  }, [task.title, optimisticTitle]);
  const shownTitle = optimisticTitle ?? task.title;
  const editable = !isTerminal(task) && !readOnly;
  const total = task.acceptanceCriteria.length;
  const ticked = task.acceptanceCriteria.filter((c) => c.done).length;

  const saveTitle = async () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!next || next === task.title) return;
    setOptimisticTitle(next);
    const res = await update.execute({ id: task.id, title: next });
    if (res.e) {
      setOptimisticTitle(null);
      toast.error(t(res.e.message));
    }
  };

  return (
    <div className={cn(expanded && 'bg-muted/20')}>
      <div className="group flex h-11 items-center gap-2.5 px-3 transition-colors hover:bg-muted/40">
        <button
          type="button"
          onClick={() => onToggle(task.id)}
          aria-expanded={expanded}
          aria-label={shownTitle}
          className="flex h-full shrink-0 items-center px-0.5"
        >
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground/60 transition-transform',
              expanded && 'rotate-90',
            )}
          />
        </button>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            className="min-w-0 flex-1 border-b border-primary/40 bg-transparent text-sm font-medium outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (expanded && editable) {
                setTitleDraft(shownTitle);
                setEditingTitle(true);
              } else {
                onToggle(task.id);
              }
            }}
            className={cn(
              'h-full min-w-0 flex-1 truncate text-left text-sm font-medium',
              expanded && editable && 'cursor-text',
            )}
          >
            {shownTitle}
          </button>
        )}
        {task.isHumanTask && (
          <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-orange-700 ring-1 ring-orange-500/20 ring-inset dark:text-orange-300">
            <UserRound className="size-3" />
            {t(k.tasks.humanTask)}
          </span>
        )}
        <AreaChip task={task} />
        <AssumptionChip task={task} />
        <FromResearchChip task={task} />
        <DependencyIndicator task={task} />
        <PrChip task={task} />
        <CiDot task={task} />
        {total > 0 && (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground tabular-nums sm:inline-flex">
            <ListChecks className="size-3.5" />
            {ticked}/{total}
          </span>
        )}
        {task.priority > 0 && (
          <span className="hidden w-7 text-right text-xs text-muted-foreground tabular-nums sm:inline">
            P{task.priority}
          </span>
        )}
        <span className="hidden w-7 text-right text-xs text-muted-foreground/70 tabular-nums md:inline">
          {ago(task.statusChangedAt ?? task.updatedAt)}
        </span>
        {actions}
        <RowMenu task={task} />
      </div>
      {expanded && children}
    </div>
  );
}

/**
 * The board's framing around the shared detail: the same indented, hairline
 * top border every expanded row has had. On the board the destructive moves
 * live in the row menu, so the detail suppresses its own copies.
 */
function BoardDetail(props: TaskDetailProps) {
  return (
    <div className="border-t py-3 pr-4 pl-9">
      <TaskDetail {...props} destructiveInMenu />
    </div>
  );
}

/**
 * approved: the merge queue. Merge stays a one-click head action even when
 * collapsed; the expanded row is the same full detail as everywhere else, and
 * the remaining approved moves (undo, send back) live in that shared body.
 */
export function ApprovedCard(props: CardProps) {
  const { task } = props;
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const busy = transition.isLoading || merge.isLoading;
  const ciFailing = task.ciState === 'failing';
  // A closed (unmerged) PR makes the server-side merge a guaranteed error —
  // the only honest offer left is completing the task by hand.
  const prClosed = task.prState === 'closed';

  const doMerge = async () => {
    const res = await merge.execute({ id: task.id });
    if (res.e) toast.error(t(res.e.message));
    else toast.success(t(k.tasks.v2.mergedToast));
  };

  return (
    <CardShell
      {...props}
      actions={
        <div className="flex items-center gap-1.5">
          {prClosed ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void transition.execute({ id: task.id, to: 'done' })}
              >
                {t(k.tasks.actions.markMerged)}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t(k.tasks.v2.prClosedHint, { n: task.prNumber ?? '?' })}
              </span>
            </>
          ) : (
            <Button size="sm" disabled={busy || ciFailing} onClick={() => void doMerge()}>
              {merge.isLoading ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : (
                <GitMerge className="size-4 mr-1" />
              )}
              {t(merge.isLoading ? k.tasks.v2.merging : k.tasks.actions.merge)}
            </Button>
          )}
        </div>
      }
    >
      <BoardDetail task={task} landInHeader />
    </CardShell>
  );
}

/** needs_review, blocked, and everything else: the shared detail, framed. */
export function ReviewCard(props: CardProps) {
  return (
    <CardShell {...props}>
      <BoardDetail task={props.task} />
    </CardShell>
  );
}

export function BlockedCard(props: CardProps) {
  return (
    <CardShell {...props}>
      <BoardDetail task={props.task} />
    </CardShell>
  );
}

export function PlainCard(props: CardProps) {
  return (
    <CardShell {...props}>
      <BoardDetail task={props.task} />
    </CardShell>
  );
}
