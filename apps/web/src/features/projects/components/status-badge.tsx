import { useTranslation } from 'react-i18next';
import type { TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

/**
 * Status is the protocol, so its color encodes whose move it is:
 * amber/violet (blocked, needs_review) = the human's court — the two states
 * worth glancing for; cool hues = agent territory; muted = parked.
 */
const styles: Record<TaskStatus, string> = {
  draft: 'bg-muted text-muted-foreground ring-transparent',
  ready: 'bg-sky-500/10 text-sky-600 dark:text-sky-300 ring-sky-500/20',
  in_progress: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-indigo-500/20',
  blocked: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/25',
  needs_review: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/25',
  changes_requested: 'bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-rose-500/20',
  done: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-emerald-500/20',
  cancelled: 'bg-muted text-muted-foreground/60 ring-transparent line-through',
};

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap',
        styles[status],
        className,
      )}
    >
      {t(k.tasks.status[status])}
    </span>
  );
}
