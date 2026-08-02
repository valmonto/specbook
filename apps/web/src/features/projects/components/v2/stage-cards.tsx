import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bot,
  Check,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitMerge,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  PanelRight,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useMergeTask, useTask, useTaskPr, useTransitionTask } from '../../hooks/use-projects';
import { AttachmentsSection } from '../attachments-section';

/**
 * Stage-shaped cards for the v2 pipeline view, as an accordion: every card
 * collapses to one row, clicking it expands it in place — and only ONE card
 * is expanded at a time (state owned by the page), so the list never turns
 * into a wall. The detail sheet remains the deep layer (full context, full
 * activity, editing) behind the panel button; these cards are the fast path.
 */

export interface CardProps {
  task: Task;
  expanded: boolean;
  /** Expand/collapse this card (the page enforces one-at-a-time). */
  onToggle: (id: string) => void;
  /** Open the full detail sheet — edit, complete activity, dependencies. */
  onDetails: (id: string) => void;
}

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
 * A list row, not a card: the page wraps rows in ONE bordered container with
 * hairline dividers. Meta is compact and right-aligned (icons + numbers,
 * words in tooltips); the details affordance appears on hover/focus only.
 */
function CardShell({
  task,
  expanded,
  onToggle,
  onDetails,
  children,
  actions,
}: CardProps & { children?: React.ReactNode; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const total = task.acceptanceCriteria.length;
  const ticked = task.acceptanceCriteria.filter((c) => c.done).length;
  return (
    <div className={cn(expanded && 'bg-muted/20')}>
      <div className="group flex h-11 items-center gap-2.5 px-3 transition-colors hover:bg-muted/40">
        <button
          type="button"
          onClick={() => onToggle(task.id)}
          aria-expanded={expanded}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span className="truncate text-sm font-medium">{task.title}</span>
        </button>
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
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          title={t(k.tasks.v2.details)}
          aria-label={t(k.tasks.v2.details)}
          onClick={() => onDetails(task.id)}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
      {expanded && children}
    </div>
  );
}

function CriteriaList({ task }: { task: Task }) {
  if (task.acceptanceCriteria.length === 0) return null;
  return (
    <ul className="grid gap-1">
      {task.acceptanceCriteria.map((c, i) => (
        <li key={i} className="flex items-start gap-1.5 text-sm">
          <Check
            className={cn(
              'mt-0.5 size-3.5 shrink-0',
              c.done ? 'text-emerald-500' : 'text-muted-foreground/40',
            )}
          />
          <span className={cn(!c.done && 'text-muted-foreground')}>{c.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The one-paragraph "what changed" the agent recorded when submitting. */
function AgentSummary({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const { data } = useTask(taskId);
  const summary = data?.comments
    .filter((c) => c.authorType === 'agent' && (c.kind === 'comment' || c.kind === 'progress'))
    .at(-1);
  return (
    <div>
      <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Bot className="size-3.5" />
        {t(k.tasks.v2.agentSummary)}
      </h4>
      <p className="text-sm whitespace-pre-wrap">{summary?.body ?? t(k.tasks.v2.noSummary)}</p>
    </div>
  );
}

/** "6 files · +214 −38 · touches apps/web, packages/contracts" — live from GitHub. */
function PrScopeLine({ task }: { task: Task }) {
  const { t } = useTranslation();
  const hasRemote = Boolean(task.branch ?? task.prUrl);
  const { data, isLoading } = useTaskPr(hasRemote ? task.id : null);
  if (!hasRemote || (!data && !isLoading)) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {isLoading || !data ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <>
          <span className="tabular-nums">
            {t(k.tasks.v2.diffStats, {
              files: data.changedFiles,
              additions: data.additions,
              deletions: data.deletions,
            })}
          </span>
          {data.areas.length > 0 && (
            <span>· {t(k.tasks.v2.touches, { areas: data.areas.join(', ') })}</span>
          )}
        </>
      )}
    </p>
  );
}

function WorkLinks({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.branch && !task.prUrl) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      {task.branch && (
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono">
          <GitBranch className="size-3" />
          {task.branch}
        </span>
      )}
      {task.prUrl && (
        <a
          href={task.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ExternalLink className="size-3" />
          {t(k.tasks.detail.openPr)}
        </a>
      )}
    </div>
  );
}

/** Shared inline feedback box for the two "send back" paths. */
function FeedbackBox({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const [feedback, setFeedback] = useState('');

  const sendBack = async () => {
    if (!feedback.trim()) return;
    const res = await transition.execute({
      id: taskId,
      to: 'changes_requested',
      comment: feedback.trim(),
    });
    if (res.e) toast.error(t(res.e.message));
    else onClose();
  };

  return (
    <div className="grid gap-2">
      <Textarea
        autoFocus
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={t(k.tasks.actions.feedbackPlaceholder)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          disabled={transition.isLoading || !feedback.trim()}
          onClick={() => void sendBack()}
        >
          {t(k.tasks.actions.requestChanges)}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t(k.common.actions.cancel)}
        </Button>
      </div>
    </div>
  );
}

/**
 * needs_review: everything needed to decide, inline — then one click.
 * "Approve & merge" chains the two server calls; a merge failure leaves the
 * task safely in the merge queue with the error surfaced.
 */
export function ReviewCard(props: CardProps) {
  const { task } = props;
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const [givingFeedback, setGivingFeedback] = useState(false);
  const busy = transition.isLoading || merge.isLoading;
  const ciFailing = task.ciState === 'failing';
  const mergeable = Boolean(task.branch ?? task.prUrl) && !ciFailing;

  const approve = async (thenMerge: boolean) => {
    const approved = await transition.execute({ id: task.id, to: 'approved' });
    if (approved.e) {
      toast.error(t(approved.e.message));
      return;
    }
    if (!thenMerge) {
      toast.success(t(k.tasks.v2.approvedToast));
      return;
    }
    const merged = await merge.execute({ id: task.id });
    if (merged.e) toast.error(t(merged.e.message));
    else toast.success(t(k.tasks.v2.mergedToast));
  };

  return (
    <CardShell {...props}>
      <div className="grid gap-3 border-t py-3 pr-4 pl-9">
        <AgentSummary taskId={task.id} />
        <CriteriaList task={task} />
        <WorkLinks task={task} />
        <PrScopeLine task={task} />
        <AttachmentsSection taskId={task.id} />

        {givingFeedback ? (
          <FeedbackBox taskId={task.id} onClose={() => setGivingFeedback(false)} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {mergeable ? (
              <Button size="sm" disabled={busy} onClick={() => void approve(true)}>
                <GitMerge className="size-4 mr-1" />
                {t(k.tasks.actions.approveMerge)}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={mergeable ? 'outline' : 'default'}
              disabled={busy}
              onClick={() => void approve(false)}
            >
              {t(k.tasks.actions.approve)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={busy}
              onClick={() => setGivingFeedback(true)}
            >
              {t(k.tasks.actions.requestChanges)}
            </Button>
            <span className="text-xs text-muted-foreground">
              {ciFailing ? t(k.tasks.v2.mergeBlockedCi) : mergeable ? t(k.tasks.v2.ciGreenHint) : null}
            </span>
          </div>
        )}
      </div>
    </CardShell>
  );
}

/**
 * approved: the merge queue. Merge stays a one-click head action even when
 * collapsed; expanding shows the evidence (summary, links, scope).
 */
export function ApprovedCard(props: CardProps) {
  const { task, expanded } = props;
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const [givingFeedback, setGivingFeedback] = useState(false);
  const busy = transition.isLoading || merge.isLoading;
  const ciFailing = task.ciState === 'failing';

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
          <Button size="sm" disabled={busy || ciFailing} onClick={() => void doMerge()}>
            {merge.isLoading ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <GitMerge className="size-4 mr-1" />
            )}
            {t(merge.isLoading ? k.tasks.v2.merging : k.tasks.actions.merge)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={t(k.tasks.actions.undoApprove)}
            aria-label={t(k.tasks.actions.undoApprove)}
            onClick={() => void transition.execute({ id: task.id, to: 'needs_review' })}
          >
            <Undo2 className="size-4" />
          </Button>
          {ciFailing && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={busy}
              onClick={() => {
                // The feedback box lives in the body — make sure it's visible.
                if (!expanded) props.onToggle(task.id);
                setGivingFeedback((open) => !open);
              }}
            >
              {t(k.tasks.actions.requestChanges)}
            </Button>
          )}
        </div>
      }
    >
      <div className="grid gap-3 border-t py-3 pr-4 pl-9">
        {ciFailing && <p className="text-xs text-destructive">{t(k.tasks.v2.mergeBlockedCi)}</p>}
        <AgentSummary taskId={task.id} />
        <WorkLinks task={task} />
        <PrScopeLine task={task} />
        {givingFeedback && (
          <FeedbackBox taskId={task.id} onClose={() => setGivingFeedback(false)} />
        )}
      </div>
    </CardShell>
  );
}

/** blocked: the agent's question with the answer box right there. */
export function BlockedCard(props: CardProps) {
  const { task, expanded } = props;
  const { t } = useTranslation();
  const { data } = useTask(expanded ? task.id : null);
  const transition = useTransitionTask();
  const [answer, setAnswer] = useState('');
  const question = data?.comments.filter((c) => c.kind === 'question').at(-1)?.body;

  const requeue = async () => {
    if (!answer.trim()) return;
    const res = await transition.execute({ id: task.id, to: 'ready', comment: answer.trim() });
    if (res.e) toast.error(t(res.e.message));
    else setAnswer('');
  };

  return (
    <CardShell {...props}>
      <div className="grid gap-2 border-t py-3 pr-4 pl-9">
        {question && (
          <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
            <span className="break-words whitespace-pre-wrap">{question}</span>
          </p>
        )}
        <Textarea
          rows={2}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={t(k.tasks.actions.answerPlaceholder)}
        />
        <div>
          <Button
            size="sm"
            disabled={transition.isLoading || !answer.trim()}
            onClick={() => void requeue()}
          >
            <RotateCcw className="size-4 mr-1" />
            {t(k.tasks.actions.requeue)}
          </Button>
        </div>
      </div>
    </CardShell>
  );
}

/**
 * Everything else: collapsed row; expanding shows the spec at a glance —
 * clamped context (the sheet has the full document), criteria, links.
 */
export function PlainCard(props: CardProps) {
  const { task } = props;
  return (
    <CardShell {...props}>
      <div className="grid gap-3 border-t py-3 pr-4 pl-9">
        {task.context && (
          <p className="line-clamp-6 text-sm whitespace-pre-wrap text-muted-foreground">
            {task.context}
          </p>
        )}
        <CriteriaList task={task} />
        <WorkLinks task={task} />
        <PrScopeLine task={task} />
      </div>
    </CardShell>
  );
}
