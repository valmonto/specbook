import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { MERGE_DEBT_CAP, type TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

/**
 * The pipeline as one row of stage chips — the v2 replacement for columns, and
 * the board's single status control. It answers "where is everything" at a
 * glance (the per-stage funnel counts) AND doubles as the status filter over
 * the always-area board: clicking a stage narrows the board to it, clicking the
 * selected stage again clears back to all stages (`selected === null`).
 *
 * The two human gates (needs_review, approved) carry an amber dot when
 * occupied; approved also shows the merge-debt cap, because hitting it
 * pauses dispatch. Rare stages (blocked, changes_requested, cancelled)
 * appear only when occupied.
 */
const ALWAYS: TaskStatus[] = ['draft', 'ready', 'in_progress', 'needs_review', 'approved', 'done'];
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
const GATES: TaskStatus[] = ['blocked', 'needs_review', 'approved'];

interface Props {
  counts: Partial<Record<TaskStatus, number>>;
  /** The stage the board is filtered to, or null when all stages show. */
  selected: TaskStatus | null;
  onSelect: (status: TaskStatus) => void;
  /**
   * Plan mode locks the strip to the Draft stage: the Draft chip reads as the
   * active scope and every other stage is visibly disabled (Plan mode only
   * ever operates on drafts), so the strip stops being a filter here.
   */
  locked?: boolean;
}

export function PipelineStrip({ counts, selected, onSelect, locked = false }: Props) {
  const { t } = useTranslation();
  const stages = ORDER.filter((s) => ALWAYS.includes(s) || (counts[s] ?? 0) > 0);

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {stages.map((status, i) => {
        const n = counts[status] ?? 0;
        const isGate = GATES.includes(status) && n > 0;
        // Locked (Plan mode): Draft is the fixed scope; the rest are inert.
        const active = locked ? status === 'draft' : selected === status;
        const disabled = locked && status !== 'draft';
        return (
          <Fragment key={status}>
            {i > 0 && <span className="hidden text-xs text-muted-foreground/40 sm:inline">→</span>}
            <button
              type="button"
              onClick={() => !locked && onSelect(status)}
              disabled={disabled}
              aria-pressed={active}
              aria-disabled={disabled}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors',
                active
                  ? 'border-primary/60 bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:border-muted-foreground/40',
                n === 0 && !active && 'opacity-50',
                disabled && 'pointer-events-none opacity-30',
              )}
            >
              {isGate && <span className="size-1.5 rounded-full bg-amber-500 shadow-[0_0_5px_2px_rgba(217,153,34,0.35)]" />}
              {t(k.tasks.status[status])}
              <span className="font-semibold text-foreground tabular-nums">{n}</span>
              {status === 'approved' && (
                <span className="text-[11px] text-muted-foreground">/{MERGE_DEBT_CAP}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
