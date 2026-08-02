import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bot,
  Check,
  ExternalLink,
  GitBranch,
  GitMerge,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
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
import { CiStateDot, PrStateBadge } from '../github-state-badges';

/**
 * Stage-shaped cards for the v2 pipeline view: the selected stage decides
 * the card's shape, so review cards carry their evidence inline (summary,
 * criteria, screenshots, scope) and the merge queue is a row of one-click
 * merges. Clicking a title always opens the full detail sheet — these cards
 * are the fast path, not the only path.
 */

interface CardProps {
  task: Task;
  onOpen: (id: string) => void;
}

function CardShell({
  task,
  onOpen,
  children,
  actions,
}: CardProps & { children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card shadow-xs">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline"
        >
          {task.title}
        </button>
        <PrStateBadge task={task} />
        <CiStateDot task={task} />
        {task.priority > 0 && (
          <span className="text-xs font-medium text-muted-foreground">P{task.priority}</span>
        )}
        {actions}
      </div>
      {children}
    </div>
  );
}

/** The one-paragraph "what changed" the agent recorded when submitting. */
function useAgentSummary(taskId: string) {
  const { data } = useTask(taskId);
  const summary = data?.comments
    .filter((c) => c.authorType === 'agent' && (c.kind === 'comment' || c.kind === 'progress'))
    .at(-1);
  return summary?.body ?? null;
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

/**
 * needs_review: everything needed to decide, inline — then one click.
 * "Approve & merge" chains the two server calls; a merge failure leaves the
 * task safely in the merge queue with the error surfaced.
 */
export function ReviewCard({ task, onOpen }: CardProps) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const [feedback, setFeedback] = useState<string | null>(null);
  const summary = useAgentSummary(task.id);
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

  const sendBack = async () => {
    if (!feedback?.trim()) return;
    const res = await transition.execute({
      id: task.id,
      to: 'changes_requested',
      comment: feedback.trim(),
    });
    if (res.e) toast.error(t(res.e.message));
    else setFeedback(null);
  };

  return (
    <CardShell task={task} onOpen={onOpen}>
      <div className="grid gap-3 border-t px-4 py-3">
        <div>
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Bot className="size-3.5" />
            {t(k.tasks.v2.agentSummary)}
          </h4>
          <p className="text-sm whitespace-pre-wrap">{summary ?? t(k.tasks.v2.noSummary)}</p>
        </div>

        {task.acceptanceCriteria.length > 0 && (
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
        )}

        <WorkLinks task={task} />
        <PrScopeLine task={task} />
        <AttachmentsSection taskId={task.id} />

        {feedback === null ? (
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
              onClick={() => setFeedback('')}
            >
              {t(k.tasks.actions.requestChanges)}
            </Button>
            <span className="text-xs text-muted-foreground">
              {ciFailing ? t(k.tasks.v2.mergeBlockedCi) : mergeable ? t(k.tasks.v2.ciGreenHint) : null}
            </span>
          </div>
        ) : (
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
                disabled={busy || !feedback.trim()}
                onClick={() => void sendBack()}
              >
                {t(k.tasks.actions.requestChanges)}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFeedback(null)}>
                {t(k.common.actions.cancel)}
              </Button>
            </div>
          </div>
        )}
      </div>
    </CardShell>
  );
}

/** approved: the merge queue — a one-click Merge per row, undo, send back. */
export function ApprovedCard({ task, onOpen }: CardProps) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const [feedback, setFeedback] = useState<string | null>(null);
  const busy = transition.isLoading || merge.isLoading;
  const ciFailing = task.ciState === 'failing';

  const doMerge = async () => {
    const res = await merge.execute({ id: task.id });
    if (res.e) toast.error(t(res.e.message));
    else toast.success(t(k.tasks.v2.mergedToast));
  };

  const sendBack = async () => {
    if (!feedback?.trim()) return;
    const res = await transition.execute({
      id: task.id,
      to: 'changes_requested',
      comment: feedback.trim(),
    });
    if (res.e) toast.error(t(res.e.message));
    else setFeedback(null);
  };

  return (
    <CardShell
      task={task}
      onOpen={onOpen}
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
              onClick={() => setFeedback(feedback === null ? '' : null)}
            >
              {t(k.tasks.actions.requestChanges)}
            </Button>
          )}
        </div>
      }
    >
      {ciFailing && (
        <p className="border-t px-4 py-2 text-xs text-destructive">{t(k.tasks.v2.mergeBlockedCi)}</p>
      )}
      {feedback !== null && (
        <div className="grid gap-2 border-t px-4 py-3">
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
              disabled={busy || !feedback.trim()}
              onClick={() => void sendBack()}
            >
              {t(k.tasks.actions.requestChanges)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFeedback(null)}>
              {t(k.common.actions.cancel)}
            </Button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

/** blocked: the agent's question with the answer box right there. */
export function BlockedCard({ task, onOpen }: CardProps) {
  const { t } = useTranslation();
  const { data } = useTask(task.id);
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
    <CardShell task={task} onOpen={onOpen}>
      <div className="grid gap-2 border-t px-4 py-3">
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

/** Everything else: a compact row; the detail sheet has the rest. */
export function PlainCard({ task, onOpen }: CardProps) {
  const total = task.acceptanceCriteria.length;
  const done = task.acceptanceCriteria.filter((c) => c.done).length;
  return (
    <CardShell
      task={task}
      onOpen={onOpen}
      actions={
        total > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <ListChecks className="size-3.5" />
            {done}/{total}
          </span>
        ) : undefined
      }
    />
  );
}
