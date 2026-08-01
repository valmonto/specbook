import { useTranslation } from 'react-i18next';
import { GitBranch, ListChecks } from 'lucide-react';
import type { Task, TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { StatusBadge } from './status-badge';

/**
 * Column order tells the loop's story left to right: authoring → queue →
 * work → human court → terminal. Terminal columns render only when occupied.
 */
const COLUMNS: TaskStatus[] = [
  'draft',
  'ready',
  'in_progress',
  'blocked',
  'needs_review',
  'changes_requested',
  'done',
  'cancelled',
];
const ALWAYS_VISIBLE: TaskStatus[] = ['draft', 'ready', 'in_progress', 'needs_review'];

function TaskCard({ task, onSelect }: { task: Task; onSelect: () => void }) {
  const total = task.acceptanceCriteria.length;
  const done = task.acceptanceCriteria.filter((c) => c.done).length;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full overflow-hidden rounded-lg border bg-card p-3 text-left shadow-xs transition-colors hover:bg-muted/50"
    >
      {/* break-words + clamp: an unbroken token (a pasted key, a long URL)
          must wrap inside the card, and a monster title must not balloon it. */}
      <p className="mb-2 line-clamp-3 text-sm leading-snug font-medium break-words">{task.title}</p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {total > 0 && (
          <span className="inline-flex items-center gap-1">
            <ListChecks className="size-3.5" />
            {done}/{total}
          </span>
        )}
        {task.branch && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{task.branch}</span>
          </span>
        )}
        {task.priority > 0 && <span className="ml-auto font-medium">P{task.priority}</span>}
      </div>
    </button>
  );
}

interface Props {
  tasks: Task[];
  onSelectTask: (id: string) => void;
}

export function TaskBoard({ tasks, onSelectTask }: Props) {
  const { t } = useTranslation();

  if (tasks.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>{t(k.tasks.noTasks)}</EmptyTitle>
          <EmptyDescription>{t(k.tasks.noTasksDesc)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const byStatus = new Map<TaskStatus, Task[]>();
  for (const task of tasks) {
    const list = byStatus.get(task.status) ?? [];
    list.push(task);
    byStatus.set(task.status, list);
  }

  const columns = COLUMNS.filter(
    (s) => ALWAYS_VISIBLE.includes(s) || (byStatus.get(s)?.length ?? 0) > 0,
  );

  // Contained horizontal scroll, quiet: no permanent scrollbar chrome —
  // trackpads/wheels scroll it; the layout above guarantees containment.
  return (
    <div className="overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max gap-4">
        {columns.map((status) => {
          const columnTasks = byStatus.get(status) ?? [];
          return (
            <Card key={status} className="w-72 shrink-0 bg-muted/30 py-0">
              <CardContent className="space-y-2 p-3">
                <div className="flex items-center justify-between px-1 pb-1">
                  <StatusBadge status={status} />
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {columnTasks.length}
                  </span>
                </div>
                {columnTasks.map((task) => (
                  <TaskCard key={task.id} task={task} onSelect={() => onSelectTask(task.id)} />
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
