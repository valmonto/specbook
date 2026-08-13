import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Input } from '@/components/ui/input';
import {
  STATUS_BUCKETS,
  isFilterActive,
  type StatusBucket,
  type TaskFilter,
} from './filter-tasks';

/**
 * The board's standalone filter: status-bucket chips + a title search. It is a
 * SEPARATE control from Group by (see GroupByControl) — the two compose. State
 * lives in the URL via the page (?status, ?q), so it survives a grouping
 * switch and is shareable; this component is a pure view over that state.
 *
 * `statuses` undefined means "all visible": every chip reads pressed. Toggling
 * a chip works off the resolved (all-if-undefined) set; landing back on all
 * four clears the param.
 */

/** Bucket → label key. Reuses the status labels; only "active" is bespoke. */
const BUCKET_LABELS: Record<StatusBucket, string> = {
  draft: k.tasks.status.draft,
  active: k.tasks.filter.active,
  done: k.tasks.status.done,
  cancelled: k.tasks.status.cancelled,
};

interface Props {
  filter: TaskFilter;
  onStatusesChange: (statuses: readonly StatusBucket[]) => void;
  onQueryChange: (query: string) => void;
  onReset: () => void;
}

export function TaskFilterBar({ filter, onStatusesChange, onQueryChange, onReset }: Props) {
  const { t } = useTranslation();
  const resolved = filter.statuses ?? STATUS_BUCKETS;
  const query = filter.query ?? '';

  const toggleBucket = (bucket: StatusBucket) => {
    const on = resolved.includes(bucket);
    const next = on ? resolved.filter((b) => b !== bucket) : [...resolved, bucket];
    onStatusesChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t(k.tasks.filter.show)}</span>
        <div className="inline-flex rounded-full border p-0.5">
          {STATUS_BUCKETS.map((bucket) => {
            const active = resolved.includes(bucket);
            return (
              <button
                key={bucket}
                type="button"
                onClick={() => toggleBucket(bucket)}
                aria-pressed={active}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[13px] whitespace-nowrap transition-colors',
                  active
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(BUCKET_LABELS[bucket])}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label={t(k.tasks.filter.searchLabel)}
          placeholder={t(k.tasks.filter.searchPlaceholder)}
          className="h-8 pl-8 text-[13px]"
        />
      </div>

      {isFilterActive(filter) && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
          {t(k.tasks.filter.clear)}
        </button>
      )}
    </div>
  );
}
