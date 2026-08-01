import { useTranslation } from 'react-i18next';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

/**
 * Live GitHub state, webhook-fed. Renders nothing when no event ever arrived
 * (prState/ciState null) — the plain branch/PR links remain the fallback, so
 * unconnected deploys look exactly like before.
 */

const prStyles: Record<NonNullable<Task['prState']>, string> = {
  open: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-emerald-500/20',
  merged: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/25',
  closed: 'bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-rose-500/20',
};

const prIcons = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const;

const ciStyles: Record<NonNullable<Task['ciState']>, string> = {
  pending: 'bg-amber-400',
  passing: 'bg-emerald-500',
  failing: 'bg-rose-500',
};

export function PrStateBadge({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation();
  if (!task.prState) return null;
  const Icon = prIcons[task.prState];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap',
        prStyles[task.prState],
        className,
      )}
    >
      <Icon className="size-3" />
      {task.prNumber ? `#${task.prNumber} ` : ''}
      {t(k.tasks.prState[task.prState])}
    </span>
  );
}

export function CiStateDot({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation();
  if (!task.ciState) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground whitespace-nowrap',
        className,
      )}
      title={t(k.tasks.ciState[task.ciState])}
    >
      <span
        className={cn(
          'size-2 rounded-full',
          ciStyles[task.ciState],
          task.ciState === 'pending' && 'animate-pulse',
        )}
      />
      {t(k.tasks.ciState[task.ciState])}
    </span>
  );
}
