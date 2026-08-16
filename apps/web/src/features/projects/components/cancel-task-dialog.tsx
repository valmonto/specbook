import { useTranslation } from 'react-i18next';
import { TERMINAL_TASK_STATUSES, type Task, type TaskDependencyInfo } from '@pkg/contracts';
import { k } from '@pkg/locales';
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

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

/**
 * The live (non-terminal) tasks that depend on this one. Cancelling the task
 * detaches these edges server-side, so the human is warned first. Terminal
 * dependents keep their edge (settled history) and are not listed. Returns []
 * when the board read model omitted `dependents` (write responses) — the cancel
 * then proceeds without a dialog, and the server still detaches correctly.
 */
export function liveDependents(task: Task): TaskDependencyInfo[] {
  return (task.dependents ?? []).filter((d) => !TERMINAL.has(d.status));
}

/**
 * Confirm dialog shown before cancelling a task that other LIVE tasks depend
 * on: it names each dependent so the human sees exactly which edges will be
 * severed. Controlled — the caller owns `open` and fires `onConfirm` on accept.
 */
export function CancelTaskDialog({
  open,
  onOpenChange,
  dependents,
  isLoading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dependents: TaskDependencyInfo[];
  isLoading: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(k.tasks.cancelConfirm.title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(k.tasks.cancelConfirm.body)}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
          {dependents.map((d) => (
            <li key={d.id} className="truncate">
              {d.title}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>{t(k.tasks.cancelConfirm.keep)}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isLoading}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {t(k.tasks.cancelConfirm.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
