import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { MERGE_DEBT_CAP, type TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

/**
 * The pipeline as one row of stage chips — the v2 replacement for columns.
 * With a WIP-capped loop and one operator, a column never holds more than a
 * handful of cards; the strip answers "where is everything" in one glance
 * and leaves the width for the card evidence below.
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

export type GroupBy = 'status' | 'area';

/**
 * The segmented Status | Area control that sits by the pipeline strip. Area
 * is the default — the SAME list under collapsible feature sections; Status
 * keeps the stage-filtered pipeline. Persisted in the URL (?group=status).
 */
export function GroupByControl({
  value,
  onChange,
}: {
  value: GroupBy;
  onChange: (group: GroupBy) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ key: GroupBy; label: string }> = [
    { key: 'status', label: t(k.tasks.groupByStatus) },
    { key: 'area', label: t(k.tasks.groupByArea) },
  ];
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span>{t(k.tasks.groupBy)}</span>
      <div className="inline-flex rounded-full border p-0.5">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={value === o.key}
            className={cn(
              'rounded-full px-2.5 py-1 text-[13px] whitespace-nowrap transition-colors',
              value === o.key
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  counts: Partial<Record<TaskStatus, number>>;
  selected: TaskStatus;
  onSelect: (status: TaskStatus) => void;
}

export function PipelineStrip({ counts, selected, onSelect }: Props) {
  const { t } = useTranslation();
  const stages = ORDER.filter((s) => ALWAYS.includes(s) || (counts[s] ?? 0) > 0);

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {stages.map((status, i) => {
        const n = counts[status] ?? 0;
        const isGate = GATES.includes(status) && n > 0;
        return (
          <Fragment key={status}>
            {i > 0 && <span className="hidden text-xs text-muted-foreground/40 sm:inline">→</span>}
            <button
              type="button"
              onClick={() => onSelect(status)}
              aria-pressed={selected === status}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors',
                selected === status
                  ? 'border-primary/60 bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:border-muted-foreground/40',
                n === 0 && selected !== status && 'opacity-50',
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
