import { useTranslation } from 'react-i18next';
import { LayoutList, Waypoints } from 'lucide-react';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

export type BoardView = 'board' | 'plan';

/**
 * The Board | Plan segmented toggle in the project board header. Board is the
 * default; Plan is the draft-only dependency planner (the hand-rolled
 * pointer/SVG canvas), reached at `?view=plan`.
 */
export function ViewToggle({
  view,
  onChange,
}: {
  view: BoardView;
  onChange: (next: BoardView) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: BoardView; label: string; icon: typeof LayoutList }> = [
    { value: 'board', label: t(k.tasks.plan.board), icon: LayoutList },
    { value: 'plan', label: t(k.tasks.plan.plan), icon: Waypoints },
  ];
  return (
    <div
      className="inline-flex rounded-lg border bg-muted/40 p-0.5"
      role="tablist"
      aria-label={t(k.tasks.plan.plan)}
    >
      {options.map(({ value, label, icon: Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(value)}
            className={cn(
              // Icon-only on phones (labels would overflow the header beside the
              // pipeline strip); full pills with a ≥40px tap target from sm up.
              'inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors sm:min-h-0',
              active
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4', active && 'text-primary')} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
