import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Cog, Settings2 } from 'lucide-react';
import type { MarkReadyScope, Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useMarkReady } from '../../hooks/use-projects';

/**
 * The bulk "mark as ready" surfaces — the project cog and the per-group
 * settings icon — both drive the ONE backend mark-ready endpoint, which
 * resolves transitive draft prerequisites server-side. Confirmation is
 * required (a count-bearing dialog): unlike the single-task action, these are
 * sweeps. On success a toast reports how many moved, and notes any
 * prerequisites pulled in.
 */

/**
 * The single-task "Mark ready" cascade — a DIRECT action (no confirmation):
 * dispatch this one draft, and let the backend promote its transitive draft
 * prerequisites too. A toast reports any it pulled in ("Also marked ready: A");
 * the projects-domain revalidation the action triggers refreshes the board so
 * the promoted prerequisites show their new status immediately. Reused by the
 * board row menu and the shared task-detail footer.
 */
export async function markSingleTaskReady(
  mark: ReturnType<typeof useMarkReady>,
  task: Task,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<void> {
  const res = await mark.execute({
    scope: { kind: 'tasks', projectId: task.projectId, taskIds: [task.id] },
  });
  if (res.e) {
    toast.error(t(res.e.message));
    return;
  }
  const extras = res.d?.prerequisites ?? [];
  if (extras.length > 0) {
    toast.success(
      t(k.tasks.markReady.alsoPromoted, { titles: extras.map((p) => p.title).join(', ') }),
    );
  }
}

/** Fire the endpoint, then report the outcome as a toast. Shared by both menus. */
function useRunMarkReady() {
  const { t } = useTranslation();
  const mark = useMarkReady();
  const run = async (scope: MarkReadyScope) => {
    const res = await mark.execute({ scope });
    if (res.e) {
      toast.error(t(res.e.message));
      return;
    }
    const promoted = res.d?.promoted ?? [];
    const prerequisites = res.d?.prerequisites ?? [];
    if (promoted.length === 0) {
      toast.info(t(k.tasks.markReady.none));
      return;
    }
    toast.success(t(k.tasks.markReady.done, { count: promoted.length }));
    if (prerequisites.length > 0) {
      toast.info(
        t(k.tasks.markReady.alsoPromoted, { titles: prerequisites.map((p) => p.title).join(', ') }),
      );
    }
  };
  return { run, isLoading: mark.isLoading };
}

/** Project-wide cog next to "New task": Mark all as ready (confirm w/ count). */
export function ProjectMarkReadyMenu({
  projectId,
  draftCount,
}: {
  projectId: string;
  draftCount: number;
}) {
  const { t } = useTranslation();
  const { run, isLoading } = useRunMarkReady();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline" aria-label={t(k.tasks.markReady.projectMenu)}>
            <Cog className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={draftCount === 0} onClick={() => setConfirming(true)}>
            {t(k.tasks.markReady.all)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.tasks.markReady.confirmAllTitle)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(k.tasks.markReady.confirmAllBody, { count: draftCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isLoading}
              onClick={async () => {
                setConfirming(false);
                await run({ kind: 'project', projectId });
              }}
            >
              {t(k.tasks.markReady.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Per-group settings icon in an Area header: Mark all in this group as ready. */
export function GroupMarkReadyMenu({
  projectId,
  area,
  draftCount,
}: {
  projectId: string;
  /** The group's Area label; null = the "No area" group. */
  area: string | null;
  draftCount: number;
}) {
  const { t } = useTranslation();
  const { run, isLoading } = useRunMarkReady();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={t(k.tasks.markReady.groupMenu)}
            onClick={(e) => e.stopPropagation()}
          >
            <Settings2 className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem disabled={draftCount === 0} onClick={() => setConfirming(true)}>
            {t(k.tasks.markReady.group)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.tasks.markReady.confirmGroupTitle)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(k.tasks.markReady.confirmGroupBody, { count: draftCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isLoading}
              onClick={async () => {
                setConfirming(false);
                await run({ kind: 'area', projectId, area });
              }}
            >
              {t(k.tasks.markReady.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
