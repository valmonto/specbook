import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { GetTaskByIdResponse } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { StatusBadge } from './status-badge';
import { useAddDependency, useProjectTasks, useRemoveDependency } from '../hooks/use-projects';

/**
 * The "depends on" editor: the picker is the project's other tasks (minus self
 * and anything already linked), and each existing edge carries a remove (×).
 * The section renders even with no edges yet — an empty task is where most
 * dependencies get wired. The server owns the invariants (same-project, self,
 * cycle); its rejection surfaces inline rather than failing silently.
 */
export function DependencyEditor({ task }: { task: GetTaskByIdResponse }) {
  const { t } = useTranslation();
  const { data: projectTasks } = useProjectTasks(task.projectId);
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const [selected, setSelected] = useState('');

  // A terminal task's wiring is history — don't offer to re-edit it.
  const editable = task.status !== 'done' && task.status !== 'cancelled';

  const linkedIds = new Set(task.dependencies.map((d) => d.id));
  const candidates = (projectTasks?.data ?? []).filter(
    (candidate) => candidate.id !== task.id && !linkedIds.has(candidate.id),
  );

  const busy = addDependency.isLoading || removeDependency.isLoading;
  const error = addDependency.error ?? removeDependency.error;

  const onAdd = async () => {
    if (!selected) return;
    const res = await addDependency.execute({ id: task.id, dependsOnTaskId: selected });
    // Keep the picker's selection on a rejection (e.g. a cycle) so the human
    // can read the inline error against the choice that caused it.
    if (!res.e) setSelected('');
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

      {editable && (
        <div className="mt-2 flex items-center gap-2">
          <NativeSelect
            size="sm"
            className="flex-1"
            value={selected}
            disabled={busy || candidates.length === 0}
            aria-label={t(k.tasks.detail.dependencyPlaceholder)}
            onChange={(e) => setSelected(e.target.value)}
          >
            <NativeSelectOption value="">
              {t(k.tasks.detail.dependencyPlaceholder)}
            </NativeSelectOption>
            {candidates.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !selected}
            onClick={() => void onAdd()}
          >
            {t(k.tasks.detail.addDependency)}
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{t(error.message)}</p>}
    </div>
  );
}
