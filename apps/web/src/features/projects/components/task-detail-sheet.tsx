import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useAgents, useTask, useUpdateTask } from '../hooks/use-projects';
import { StatusBadge } from './status-badge';
import { TaskDetail } from './task-detail';

/**
 * The "Your move" slide-over: a thin frame around the shared <TaskDetail>. It
 * owns only the slide-over chrome — status, the claim's liveness, and a
 * click-to-rename title — so the inbox and the project board show the exact
 * same detail body. It has no overflow menu, so TaskDetail keeps its own
 * cancel/delete moves (destructiveInMenu defaults to false).
 */

/** Compact recency for the liveness chip. */
function agoShort(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * Liveness of whoever holds the claim: resolved from the agents list by
 * current task, so a dead runner is visible right where the claim is shown.
 */
function ClaimantLiveness({ taskId, claimed }: { taskId: string; claimed: boolean }) {
  const { t } = useTranslation();
  const { data } = useAgents();
  if (!claimed) return null;
  const agent = (data?.data ?? []).find((a) => a.currentTaskId === taskId);
  if (!agent) return null;
  const offline = agent.status === 'offline';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        offline ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground',
      )}
    >
      <span className={cn('size-1.5 rounded-full', offline ? 'bg-amber-500' : 'bg-emerald-500')} />
      {agent.name}
      {agent.lastSeenAt && ` · ${t(k.agents.seen, { when: agoShort(agent.lastSeenAt) })}`}
    </span>
  );
}

/** Click-to-rename title — the same inline-edit idiom the board row uses. */
function SheetTitleEdit({
  taskId,
  title,
  editable,
}: {
  taskId: string;
  title: string;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);

  const save = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) return;
    const res = await update.execute({ id: taskId, title: next });
    if (res.e) toast.error(t(res.e.message));
  };

  if (!editable) {
    return <SheetTitle className="text-left leading-snug">{title}</SheetTitle>;
  }
  return editing ? (
    <input
      autoFocus
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setEditing(false);
      }}
      className="min-w-0 flex-1 border-b border-primary/40 bg-transparent text-lg font-semibold outline-none"
    />
  ) : (
    <div className="flex flex-1 items-start justify-between gap-2">
      <SheetTitle className="text-left leading-snug">{title}</SheetTitle>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground"
        onClick={() => setEditing(true)}
        aria-label={t(k.common.actions.edit)}
      >
        <Pencil className="size-4" />
      </Button>
    </div>
  );
}

interface Props {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailSheet({ taskId, onOpenChange }: Props) {
  const { t } = useTranslation();
  const { data: task, isLoading } = useTask(taskId);
  const editable = task ? task.status !== 'done' && task.status !== 'cancelled' : false;

  return (
    <Sheet open={taskId !== null} onOpenChange={onOpenChange}>
      {/* Scrolling lives on an INNER div, never on SheetContent itself: the
          content element carries the slide-in transform, and scrolling a
          transformed element leaves stale composited layers behind (ghost
          double-painted text when reversing scroll direction). */}
      <SheetContent className="w-full sm:max-w-xl">
        <div className="min-h-0 flex-1 overflow-y-auto">
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
                      {t(k.tasks.detail.claimedAgo, { when: agoShort(task.claimedAt) })}
                    </span>
                  )}
                  <ClaimantLiveness taskId={task.id} claimed={Boolean(task.claimedBy)} />
                </div>
                <SheetTitleEdit taskId={task.id} title={task.title} editable={editable} />
              </SheetHeader>

              <div className="px-4 pb-8">
                <TaskDetail task={task} />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
