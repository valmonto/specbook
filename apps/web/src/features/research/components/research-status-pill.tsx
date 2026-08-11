import { useTranslation } from 'react-i18next';
import type { ResearchStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

/**
 * Status encodes whose move it is: violet (a turn is in flight) = the agent is
 * working; amber (needs_review) = the human's court; emerald (accepted) =
 * finalized. The researching dot pulses so an in-flight document reads at a
 * glance.
 */
const styles: Record<ResearchStatus, { pill: string; dot: string; pulse?: boolean }> = {
  researching: {
    pill: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/25',
    dot: 'bg-violet-500',
    pulse: true,
  },
  needs_review: {
    pill: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/25',
    dot: 'bg-amber-500',
  },
  accepted: {
    pill: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/25',
    dot: 'bg-emerald-500',
  },
};

export function ResearchStatusPill({
  status,
  className,
}: {
  status: ResearchStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const s = styles[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap',
        s.pill,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', s.dot, s.pulse && 'animate-pulse')} />
      {t(k.research.status[status])}
    </span>
  );
}
