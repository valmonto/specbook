import { useTranslation } from 'react-i18next';
import { LayoutList, Waypoints, Workflow } from 'lucide-react';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

export type BoardView = 'board' | 'plan' | 'plan2';

/**
 * The Board | Plan v1 | Plan v2 segmented toggle in the project board header.
 * Board is the default; the two Plan tabs are an A/B of the draft-only
 * dependency planner — v1 is the React Flow + dagre canvas, v2 is the
 * hand-rolled pointer/SVG canvas ported from the preferred mockup.
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
    { value: 'plan', label: t(k.tasks.plan.planV1), icon: Workflow },
    { value: 'plan2', label: t(k.tasks.plan.planV2), icon: Waypoints },
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
            onClick={() => onChange(value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors',
              active
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4', active && 'text-primary')} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
