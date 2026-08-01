import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ExternalLink, GitBranch, MessageSquare, User } from 'lucide-react';
import type { TaskCommentKind, TaskStatus, TransitionTaskRequest } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddComment,
  useCheckCriterion,
  useDeleteTask,
  useTask,
  useTransitionTask,
} from '../hooks/use-projects';
import { AttachmentsSection } from './attachments-section';
import { StatusBadge } from './status-badge';

/**
 * The human court's controls: each status offers exactly the legal human
 * moves (mirroring HUMAN_TASK_TRANSITIONS — the API enforces them anyway).
 * Actions that carry the protocol's payload (feedback, answers) open an
 * inline comment box instead of firing immediately.
 */
interface HumanAction {
  labelKey: string;
  to: TaskStatus;
  needsComment?: boolean;
  commentPlaceholderKey?: string;
  destructive?: boolean;
}

const ACTIONS: Partial<Record<TaskStatus, HumanAction[]>> = {
  draft: [{ labelKey: k.tasks.actions.markReady, to: 'ready' }],
  ready: [{ labelKey: k.tasks.actions.backToDraft, to: 'draft' }],
  in_progress: [{ labelKey: k.tasks.actions.resetClaim, to: 'ready' }],
  blocked: [
    {
      labelKey: k.tasks.actions.requeue,
      to: 'ready',
      needsComment: true,
      commentPlaceholderKey: k.tasks.actions.answerPlaceholder,
    },
    {
      labelKey: k.tasks.actions.resume,
      to: 'in_progress',
      needsComment: true,
      commentPlaceholderKey: k.tasks.actions.answerPlaceholder,
    },
  ],
  needs_review: [
    { labelKey: k.tasks.actions.approve, to: 'done' },
    {
      labelKey: k.tasks.actions.requestChanges,
      to: 'changes_requested',
      needsComment: true,
      commentPlaceholderKey: k.tasks.actions.feedbackPlaceholder,
      destructive: true,
    },
  ],
  changes_requested: [{ labelKey: k.tasks.actions.markReady, to: 'ready' }],
};

const CANCELLABLE: TaskStatus[] = [
  'draft',
  'ready',
  'in_progress',
  'blocked',
  'needs_review',
  'changes_requested',
];

const kindStyles: Record<TaskCommentKind, string> = {
  comment: 'bg-muted text-muted-foreground',
  progress: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  question: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  answer: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
};

interface Props {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailSheet({ taskId, onOpenChange }: Props) {
  const { t, i18n } = useTranslation();
  const { data: task, isLoading } = useTask(taskId);
  const transition = useTransitionTask();
  const checkCriterion = useCheckCriterion();
  const addComment = useAddComment();
  const deleteTask = useDeleteTask();

  // Which action is waiting for its comment payload.
  const [pending, setPending] = useState<HumanAction | null>(null);
  const [actionComment, setActionComment] = useState('');
  const [newComment, setNewComment] = useState('');

  const busy = transition.isLoading || deleteTask.isLoading;
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const runTransition = async (dto: TransitionTaskRequest) => {
    const res = await transition.execute(dto);
    if (!res.e) {
      setPending(null);
      setActionComment('');
    }
  };

  const onAction = (action: HumanAction) => {
    if (action.needsComment) {
      setPending(action);
      setActionComment('');
      return;
    }
    void runTransition({ id: task!.id, to: action.to });
  };

  const submitComment = async () => {
    if (!newComment.trim() || !task) return;
    const res = await addComment.execute({ id: task.id, kind: 'comment', body: newComment.trim() });
    if (!res.e) setNewComment('');
  };

  const error = transition.error ?? checkCriterion.error ?? addComment.error ?? deleteTask.error;

  return (
    <Sheet open={taskId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {isLoading || !task ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader className="pb-2">
              <div className="flex items-center gap-2">
                <StatusBadge status={task.status} />
                {task.claimedBy && task.claimedAt && (
                  <span className="text-xs text-muted-foreground">
                    {t(k.tasks.detail.claimedAgo, { when: fmtDate(task.claimedAt) })}
                  </span>
                )}
              </div>
              <SheetTitle className="text-left leading-snug">{task.title}</SheetTitle>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-8">
              {/* Spec */}
              {task.context && (
                <section>
                  <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {t(k.tasks.taskContext)}
                  </h4>
                  <p className="text-sm whitespace-pre-wrap">{task.context}</p>
                </section>
              )}
              {task.outOfScope && (
                <section>
                  <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {t(k.tasks.outOfScope)}
                  </h4>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                    {task.outOfScope}
                  </p>
                </section>
              )}

              {/* Acceptance criteria — the machine-checkable definition of done */}
              {task.acceptanceCriteria.length > 0 && (
                <section>
                  <h4 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {t(k.tasks.acceptanceCriteria)} (
                    {task.acceptanceCriteria.filter((c) => c.done).length}/
                    {task.acceptanceCriteria.length})
                  </h4>
                  <ul className="space-y-1.5">
                    {task.acceptanceCriteria.map((c, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <Checkbox
                          checked={c.done}
                          disabled={checkCriterion.isLoading}
                          onCheckedChange={(checked) =>
                            void checkCriterion.execute({
                              id: task.id,
                              index: i,
                              done: checked === true,
                            })
                          }
                          className="mt-0.5"
                        />
                        <span className={cn('text-sm', c.done && 'text-muted-foreground line-through')}>
                          {c.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Work product links */}
              {(task.branch ?? task.prUrl) && (
                <section className="flex flex-wrap items-center gap-3 text-sm">
                  {task.branch && (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-xs">
                      <GitBranch className="size-3.5" />
                      {task.branch}
                    </span>
                  )}
                  {task.prUrl && (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-primary hover:underline"
                    >
                      <ExternalLink className="size-3.5" />
                      {t(k.tasks.detail.openPr)}
                    </a>
                  )}
                </section>
              )}

              {/* Dependencies */}
              {(task.dependencies.length > 0 || task.dependents.length > 0) && (
                <section className="grid gap-3 sm:grid-cols-2">
                  {task.dependencies.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {t(k.tasks.detail.dependencies)}
                      </h4>
                      <ul className="space-y-1">
                        {task.dependencies.map((d) => (
                          <li key={d.id} className="flex items-center gap-2 text-sm">
                            <StatusBadge status={d.status} />
                            <span className="truncate">{d.title}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {task.dependents.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {t(k.tasks.detail.dependents)}
                      </h4>
                      <ul className="space-y-1">
                        {task.dependents.map((d) => (
                          <li key={d.id} className="flex items-center gap-2 text-sm">
                            <StatusBadge status={d.status} />
                            <span className="truncate">{d.title}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              {/* Transitions — the human's legal moves */}
              <section className="space-y-2">
                <Separator />
                {error && <p className="text-sm text-destructive">{t(error.message)}</p>}
                {pending ? (
                  <div className="space-y-2">
                    <Textarea
                      autoFocus
                      value={actionComment}
                      onChange={(e) => setActionComment(e.target.value)}
                      placeholder={
                        pending.commentPlaceholderKey ? t(pending.commentPlaceholderKey) : ''
                      }
                      rows={3}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy || !actionComment.trim()}
                        onClick={() =>
                          void runTransition({
                            id: task.id,
                            to: pending.to,
                            comment: actionComment.trim(),
                          })
                        }
                      >
                        <Check className="size-4 mr-1" />
                        {t(pending.labelKey)}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                        {t(k.common.actions.cancel)}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {(ACTIONS[task.status] ?? []).map((action) => (
                      <Button
                        key={action.labelKey}
                        size="sm"
                        variant={action.destructive ? 'outline' : 'default'}
                        className={cn(action.destructive && 'text-destructive')}
                        disabled={busy}
                        onClick={() => onAction(action)}
                      >
                        {t(action.labelKey)}
                      </Button>
                    ))}
                    {task.status === 'draft' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        disabled={busy}
                        onClick={async () => {
                          const res = await deleteTask.execute({ id: task.id });
                          if (!res.e) onOpenChange(false);
                        }}
                      >
                        {t(k.tasks.actions.deleteDraft)}
                      </Button>
                    )}
                    {task.status !== 'draft' && CANCELLABLE.includes(task.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={busy}
                        onClick={() => void runTransition({ id: task.id, to: 'cancelled' })}
                      >
                        {t(k.tasks.actions.cancelTask)}
                      </Button>
                    )}
                  </div>
                )}
              </section>

              {/* Proof-of-work files */}
              <AttachmentsSection taskId={task.id} />

              {/* Activity log */}
              <section className="space-y-3">
                <h4 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <MessageSquare className="size-3.5" />
                  {t(k.tasks.detail.comments)}
                </h4>
                {task.comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t(k.tasks.detail.noComments)}</p>
                ) : (
                  <ul className="space-y-3">
                    {task.comments.map((c) => (
                      <li key={c.id} className="rounded-lg border bg-card/50 p-3">
                        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                          {c.authorType === 'agent' ? (
                            <Bot className="size-3.5" />
                          ) : (
                            <User className="size-3.5" />
                          )}
                          <span>
                            {t(c.authorType === 'agent' ? k.tasks.detail.agent : k.tasks.detail.you)}
                          </span>
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                              kindStyles[c.kind],
                            )}
                          >
                            {t(k.tasks.detail.kind[c.kind])}
                          </span>
                          <span className="ml-auto">{fmtDate(c.createdAt)}</span>
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{c.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="space-y-2">
                  <Textarea
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder={t(k.tasks.detail.commentPlaceholder)}
                    rows={2}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={addComment.isLoading || !newComment.trim()}
                    onClick={() => void submitComment()}
                  >
                    {t(k.tasks.detail.addComment)}
                  </Button>
                </div>
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
