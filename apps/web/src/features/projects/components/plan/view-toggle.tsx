import { useTranslation } from 'react-i18next';
import { LayoutList, Workflow } from 'lucide-react';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';

export type BoardView = 'board' | 'plan';

/**
 * The Board ⇄ Plan segmented toggle in the project board header. Board is the
 * default; Plan switches the surface to the draft-only dependency planner.
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
    { value: 'plan', label: t(k.tasks.plan.plan), icon: Workflow },
  ];
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5" role="tablist" aria-label={t(k.tasks.plan.plan)}>
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
