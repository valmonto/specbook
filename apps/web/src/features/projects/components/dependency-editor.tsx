import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, X } from 'lucide-react';
import type { GetTaskByIdResponse, Task } from '@pkg/contracts';
import { TERMINAL_TASK_STATUSES } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { StatusBadge } from './status-badge';
import { useAddDependency, useProjectTasks, useRemoveDependency } from '../hooks/use-projects';

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

/**
 * The "depends on" editor: the picker is a searchable typeahead over the
 * project's other tasks, and each existing edge carries a remove (×). The
 * section renders even with no edges yet — an empty task is where most
 * dependencies get wired. The server owns the invariants (same-project, self,
 * cycle); its rejection surfaces inline rather than failing silently.
 */
export function DependencyEditor({ task }: { task: GetTaskByIdResponse }) {
  const { t } = useTranslation();
  const { data: projectTasks } = useProjectTasks(task.projectId);
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const [selected, setSelected] = useState<Task | null>(null);

  // A terminal task's wiring is history — don't offer to re-edit it.
  const editable = task.status !== 'done' && task.status !== 'cancelled';

  const linkedIds = new Set(task.dependencies.map((d) => d.id));
  // Only NON-terminal candidates: depending on a done task is a no-op (instantly
  // satisfied) and on a cancelled one is meaningless — plus the standing self +
  // already-linked exclusions.
  const candidates = (projectTasks?.data ?? []).filter(
    (candidate) =>
      candidate.id !== task.id &&
      !linkedIds.has(candidate.id) &&
      !TERMINAL.has(candidate.status),
  );

  const busy = addDependency.isLoading || removeDependency.isLoading;
  const error = addDependency.error ?? removeDependency.error;

  const onAdd = async () => {
    if (!selected) return;
    const res = await addDependency.execute({ id: task.id, dependsOnTaskId: selected.id });
    // Keep the picker's selection on a rejection (e.g. a cycle) so the human
    // can read the inline error against the choice that caused it.
    if (!res.e) setSelected(null);
  };

  return (
    <div>
      <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t(k.tasks.detail.dependencies)}
      </h4>
      {task.dependencies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(k.tasks.detail.noDependencies)}</p>
      ) : (
        <ul className="space-y-1">
          {task.dependencies.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-sm">
              <StatusBadge status={d.status} />
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              {editable && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground"
                  disabled={busy}
                  aria-label={t(k.tasks.detail.removeDependency)}
                  onClick={() =>
                    void removeDependency.execute({ id: task.id, dependsOnTaskId: d.id })
                  }
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable &&
        (candidates.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t(k.tasks.detail.dependencyEmpty)}</p>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <Combobox<Task>
              items={candidates}
              value={selected}
              onValueChange={setSelected}
              itemToStringLabel={(candidate) => candidate.title}
            >
              <ComboboxInput
                className="flex-1"
                disabled={busy}
                placeholder={t(k.tasks.detail.dependencySearch)}
                aria-label={t(k.tasks.detail.dependencyPlaceholder)}
              />
              <ComboboxContent>
                <ComboboxEmpty>{t(k.tasks.detail.dependencyEmpty)}</ComboboxEmpty>
                <ComboboxList>
                  {(candidate: Task) => (
                    <ComboboxItem key={candidate.id} value={candidate} className="gap-2">
                      <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                      <StatusBadge status={candidate.status} className="shrink-0" />
                      {candidate.area && (
                        <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground">
                          <Tag className="size-3 shrink-0" />
                          <span className="max-w-[8rem] truncate">{candidate.area}</span>
                        </span>
                      )}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !selected}
              onClick={() => void onAdd()}
            >
              {t(k.tasks.detail.addDependency)}
            </Button>
          </div>
        ))}

      {error && <p className="mt-2 text-sm text-destructive">{t(error.message)}</p>}
    </div>
  );
}
