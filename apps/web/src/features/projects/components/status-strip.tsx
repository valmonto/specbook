import { useTranslation } from 'react-i18next';
import type { TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** Board order — the strip reads left to right like the loop flows. */
const ORDER: TaskStatus[] = [
  'draft',
  'ready',
  'in_progress',
  'blocked',
  'needs_review',
  'approved',
  'changes_requested',
  'done',
  'cancelled',
];

/**
 * Solid segment fills from the same hues as the status badges. Human-court
 * statuses (blocked, needs_review) stay full-strength; everything else is
 * muted — one glance answers "does this project wait on me".
 */
const FILL: Record<TaskStatus, string> = {
  draft: 'bg-muted-foreground/25',
  ready: 'bg-sky-500/45',
  in_progress: 'bg-indigo-500/45',
  blocked: 'bg-amber-500',
  needs_review: 'bg-violet-500',
  approved: 'bg-teal-500',
  changes_requested: 'bg-rose-500/45',
  done: 'bg-emerald-500/35',
  cancelled: 'bg-muted-foreground/15',
};

interface Props {
  counts: Partial<Record<string, number>>;
  className?: string;
}

/**
 * A miniature of the protocol, not a metric: task counts by status as a
 * thin segmented strip. Deliberately no percentages and no printed numbers —
 * counts live in the hover tooltip.
 */
export function StatusStrip({ counts, className }: Props) {
  const { t } = useTranslation();
  const segments = ORDER.map((status) => ({ status, n: counts[status] ?? 0 })).filter(
    (segment) => segment.n > 0,
  );
  const total = segments.reduce((sum, segment) => sum + segment.n, 0);
  if (total === 0) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn('flex h-1.5 w-full gap-px overflow-hidden rounded-full', className)}
            aria-hidden
          >
            {segments.map(({ status, n }) => (
              <span
                key={status}
                className={cn('h-full rounded-[1px]', FILL[status])}
                style={{ width: `${(n / total) * 100}%` }}
              />
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="grid gap-0.5">
            {segments.map(({ status, n }) => (
              <p key={status} className="flex items-center gap-2 text-xs">
                <span className={cn('size-2 rounded-full', FILL[status])} />
                <span>{t(k.tasks.status[status])}</span>
                <span className="ml-auto pl-3 tabular-nums">{n}</span>
              </p>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
