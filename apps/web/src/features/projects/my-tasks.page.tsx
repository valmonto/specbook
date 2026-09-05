import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList } from 'lucide-react';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/shared/components/page-header';
import { StatusBadge } from './components/status-badge';
import { CiStateDot, PrStateBadge } from './components/github-state-badges';
import { TaskDetailSheet } from './components/task-detail-sheet';
import { useMyTasks, useProjects } from './hooks/use-projects';

/**
 * The human worker lane's "My tasks" — the intern's inbox. Every task assigned
 * to the current user, each card carrying the brief (context) and the
 * acceptance criteria, so "what am I building, and what counts as done" is
 * answerable without opening anything. Clicking a card opens the shared task
 * detail (where start-work / link-PR / request-review / sync live).
 */
export default function MyTasksPage() {
  const { t } = useTranslation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { data, isLoading } = useMyTasks();
  const { data: projectsData } = useProjects();

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsData?.data ?? []) map.set(p.id, p.name);
    return (id: string) => map.get(id) ?? '';
  }, [projectsData]);

  // Terminal work sinks to the bottom — the open tasks are the ones to act on.
  const tasks = useMemo(() => {
    const rank = (s: Task['status']) => (s === 'done' || s === 'cancelled' ? 1 : 0);
    return [...(data?.data ?? [])].sort((a, b) => rank(a.status) - rank(b.status));
  }, [data]);

  const Card = ({ task }: { task: Task }) => {
    const done = task.acceptanceCriteria.filter((c) => c.done).length;
    return (
      <button
        type="button"
        onClick={() => setSelectedTaskId(task.id)}
        className="flex w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left shadow-xs transition-colors hover:bg-muted/50"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={task.status} />
          <PrStateBadge task={task} />
          <CiStateDot task={task} />
          <span className="truncate text-xs text-muted-foreground">
            {projectName(task.projectId)}
          </span>
        </div>
        <p className="text-sm font-medium break-words">{task.title}</p>
        {task.context && (
          <p className="line-clamp-2 text-xs text-muted-foreground break-words whitespace-pre-wrap">
            {task.context}
          </p>
        )}
        {task.acceptanceCriteria.length > 0 && (
          <div className="grid grid-cols-1 gap-0.5">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t(k.tasks.acceptanceCriteria)} ({done}/{task.acceptanceCriteria.length})
            </span>
            <ul className="grid grid-cols-1 gap-0.5">
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                      c.done
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-muted-foreground/40',
                    )}
                  >
                    {c.done && <Check className="size-2.5" />}
                  </span>
                  <span
                    className={cn('break-words', c.done && 'text-muted-foreground line-through')}
                  >
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ClipboardList}
        title={t(k.tasks.myTasks)}
        description={t(k.tasks.myTasksDescription)}
      />
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{t(k.tasks.myTasksEmpty)}</EmptyTitle>
            <EmptyDescription>{t(k.tasks.myTasksDescription)}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <Card key={task.id} task={task} />
          ))}
        </div>
      )}
      <TaskDetailSheet
        taskId={selectedTaskId}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
      />
    </div>
  );
}
