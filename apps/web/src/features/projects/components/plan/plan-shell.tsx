import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Info, ListTree, Plus, Waypoints, Wand2 } from 'lucide-react';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCreateTask } from '../../hooks/use-projects';

/** The three colour/edge legend items — shared by the desktop row and the
 *  mobile info popover so the two never drift. */
function LegendItems() {
  const { t } = useTranslation();
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-sky-500" />
        {t(k.tasks.plan.clearLegend)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-amber-500" />
        {t(k.tasks.plan.waitingLegend)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-primary" />
        {t(k.tasks.plan.linkLegend)}
      </span>
    </>
  );
}

/**
 * The chrome shared by both Plan tabs (v1 React Flow, v2 hand-rolled canvas):
 * the note banner + Tidy/New tools, the empty state, and the legend. Only the
 * canvas itself differs, so each variant supplies it through `children` — a
 * render prop that receives the draft-scoped task set and a `registerTidy`
 * callback the Tidy button drives. Keeping this one shell means the two A/B
 * canvases stay pixel-identical everywhere except the graph surface.
 */
export function PlanShell({
  projectId,
  tasks,
  readOnly,
  children,
}: {
  projectId: string;
  /** The full project task set; Plan mode scopes itself to the drafts. */
  tasks: Task[];
  readOnly: boolean;
  children: (ctx: { draftTasks: Task[]; registerTidy: (fn: () => void) => void }) => ReactNode;
}) {
  const { t } = useTranslation();
  const create = useCreateTask();
  const draftTasks = useMemo(() => tasks.filter((task) => task.status === 'draft'), [tasks]);

  const tidyRef = useRef<(() => void) | null>(null);
  const registerTidy = useCallback((fn: () => void) => {
    tidyRef.current = fn;
  }, []);

  const newTicket = async () => {
    const res = await create.execute({ projectId, title: t(k.tasks.v2.untitled) });
    if (res.e) toast.error(t(res.e.message));
  };

  return (
    <div className="flex h-[72vh] min-h-[520px] flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
      {/* Plan note + tools: a quiet banner explaining the mode, Tidy + New. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <Waypoints className="size-4 shrink-0 text-primary" />
        {/* Full-width on phones so Tidy/New wrap onto their own line rather than
            crushing the note into a tall sliver; shares the row from sm up. */}
        <span className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-auto">
          {t(k.tasks.plan.note)}
        </span>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-10 sm:h-8"
              onClick={() => tidyRef.current?.()}
            >
              <Wand2 className="size-4 mr-1" />
              {t(k.tasks.plan.tidy)}
            </Button>
            <Button
              size="sm"
              className="h-10 sm:h-8"
              disabled={create.isLoading}
              onClick={() => void newTicket()}
            >
              <Plus className="size-4 mr-1" />
              {t(k.tasks.plan.newTicket)}
            </Button>
          </div>
        )}
      </div>

      {/* The canvas (or an empty state when there are no drafts to plan). */}
      <div className="relative min-h-0 flex-1">
        {draftTasks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <ListTree className="size-8 text-muted-foreground/50" />
            <p className="max-w-sm text-sm text-muted-foreground">{t(k.tasks.plan.empty)}</p>
            {!readOnly && (
              <Button
                size="sm"
                className="mt-1"
                disabled={create.isLoading}
                onClick={() => void newTicket()}
              >
                <Plus className="size-4 mr-1" />
                {t(k.tasks.plan.newTicket)}
              </Button>
            )}
          </div>
        ) : (
          children({ draftTasks, registerTidy })
        )}
      </div>

      {/* Legend: what the card colours and the edges mean. On phones it would
          crowd the footer, so it collapses into an info popover; the inline row
          returns from sm up (with the interaction hint on the right). */}
      <div className="flex items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[11px] text-muted-foreground">
        <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 sm:flex">
          <LegendItems />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t(k.tasks.plan.legendTitle)}
              className="inline-flex min-h-[40px] items-center gap-1.5 text-muted-foreground sm:hidden"
            >
              <Info className="size-4" />
              {t(k.tasks.plan.legendTitle)}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 text-xs text-muted-foreground">
            <div className="flex flex-col gap-2">
              <LegendItems />
              <p className="border-t pt-2">{t(k.tasks.plan.hint)}</p>
            </div>
          </PopoverContent>
        </Popover>
        <span className="ml-auto hidden sm:inline">{t(k.tasks.plan.hint)}</span>
      </div>
    </div>
  );
}
