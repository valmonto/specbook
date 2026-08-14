import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, ArrowLeft, ChevronRight, GitMerge, Pause, Plus } from 'lucide-react';
import { MERGE_DEBT_CAP, TASK_STATUSES, type Task, type TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectContextSection, ProjectHeader } from './components/v2/project-header';
import { PipelineStrip } from './components/v2/pipeline-strip';
import { groupTasksByArea } from './components/v2/group-tasks';
import { TaskSearch } from './components/v2/task-search';
import { filterTasks } from './components/v2/filter-tasks';
import { cardFor, ShowAreaChipContext } from './components/v2/stage-cards';
import { GroupMarkReadyMenu, ProjectMarkReadyMenu } from './components/v2/mark-ready-menu';
import {
  useCreateTask,
  useMergeTask,
  useProject,
  useProjectTasks,
  useUnarchiveProject,
} from './hooks/use-projects';
import { ProjectReadOnlyContext } from './components/v2/read-only-context';
import { EnvironmentsSection } from './components/environments-section';
import { useCan } from '@/shared/hooks/use-permissions';

/**
 * The project view: the pipeline strip over an always-Area board. The strip is
 * the one status control — it shows the per-stage funnel counts AND filters the
 * area-grouped board to a stage. A title search sits beside it. Rows expand in
 * place to the full task detail (see v2/stage-cards).
 *
 * The board opens on Draft: with no `?stage` param the view lands on the Draft
 * stage, the loop's inbox. Show-all stays reachable through an explicit `all`
 * sentinel — deselecting the Draft chip (or any active stage) sets `?stage=all`
 * rather than clearing the param, so "show everything" never collapses back
 * into the Draft default. An explicit `?stage=<status>` still overrides.
 */
// The URL sentinel for "no stage filter — show every stage". Kept distinct
// from an absent param (which is the Draft default) so show-all is reachable.
const SHOW_ALL = 'all';

/** The three-bucket rollup an area section header carries at a glance. */
interface Rollup {
  done: number;
  inProgress: number;
  draft: number;
}
const rollupOf = (tasks: Task[]): Rollup => {
  const roll: Rollup = { done: 0, inProgress: 0, draft: 0 };
  for (const task of tasks) {
    if (task.status === 'done') roll.done += 1;
    else if (task.status === 'draft') roll.draft += 1;
    else if (task.status !== 'cancelled') roll.inProgress += 1;
  }
  return roll;
};

/** A tiny status rollup bar + counts for a feature section header. */
function RollupBar({ roll }: { roll: Rollup }) {
  const { t } = useTranslation();
  const segments = [
    { n: roll.done, cls: 'bg-emerald-500', label: t(k.tasks.status.done) },
    { n: roll.inProgress, cls: 'bg-indigo-500', label: t(k.tasks.status.in_progress) },
    { n: roll.draft, cls: 'bg-muted-foreground/40', label: t(k.tasks.status.draft) },
  ];
  const denom = roll.done + roll.inProgress + roll.draft || 1;
  return (
    <div className="flex items-center gap-2">
      <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-muted sm:flex">
        {segments.map(
          (s) =>
            s.n > 0 && (
              <span
                key={s.label}
                className={cn('h-full', s.cls)}
                style={{ width: `${(s.n / denom) * 100}%` }}
                title={`${s.label}: ${s.n}`}
              />
            ),
        )}
      </div>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-0.5" title={s.label}>
            <span className={cn('size-1.5 rounded-full', s.cls)} />
            {s.n}
          </span>
        ))}
      </span>
    </div>
  );
}

export default function ProjectDetailV2Page() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project, isLoading } = useProject(projectId ?? null);
  const { data: tasksData, isLoading: tasksLoading } = useProjectTasks(projectId ?? null);
  const merge = useMergeTask();
  const create = useCreateTask();
  const unarchive = useUnarchiveProject();
  const canManage = useCan('project:delete');

  // The two board controls live in the URL, so reloads and shared links restore
  // the same view:
  // - ?stage=needs_review: the pipeline strip's status filter. A concrete status
  //   filters to it; the `all` sentinel shows every stage; absent (or an unknown
  //   value) falls back to the Draft default (`stage` = 'draft').
  // - ?q=: the title search. Orthogonal to the stage filter; the two compose.
  const [searchParams, setSearchParams] = useSearchParams();
  const stageParam = searchParams.get('stage');
  const stage: TaskStatus | null =
    stageParam === SHOW_ALL
      ? null
      : stageParam && (TASK_STATUSES as readonly string[]).includes(stageParam)
        ? (stageParam as TaskStatus)
        : 'draft';
  const query = searchParams.get('q') ?? '';
  // One card expanded at a time — the accordion state the cards share.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The just-created draft: its row mounts with the title already in edit mode.
  const [freshId, setFreshId] = useState<string | null>(null);
  // Collapsed feature sections — keyed by area label; '' = No area.
  const [collapsedAreas, setCollapsedAreas] = useState<Set<string>>(new Set());

  // Every setter patches the existing params (never replaces the whole set),
  // so the two orthogonal controls — stage and search — never wipe each other.
  const patchParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        mutate(params);
        return params;
      },
      { replace: true },
    );
  };
  // Clicking a stage filters to it; clicking the already-selected stage
  // deselects to the explicit show-all sentinel — never an absent param, which
  // would snap back to the Draft default and strand show-all. The strip IS the
  // one status control now.
  const setStage = (next: TaskStatus) => {
    patchParams((params) => {
      params.set('stage', stage === next ? SHOW_ALL : next);
    });
    setExpandedId(null);
  };
  const setQuery = (next: string) => {
    patchParams((params) => {
      if (next.trim() === '') params.delete('q');
      else params.set('q', next);
    });
  };
  const toggleArea = (key: string) =>
    setCollapsedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleExpanded = (id: string) => setExpandedId((prev) => (prev === id ? null : id));

  // Creation IS editing: make the draft immediately, land on it expanded with
  // the title focused — no form, no dialog. Drop the board's filters to show-all
  // and clear any search first, so the fresh (untitled, area-less) draft is
  // guaranteed visible in its section rather than hidden behind a stage filter
  // or a stale search.
  const newTask = async () => {
    if (!project) return;
    const res = await create.execute({ projectId: project.id, title: t(k.tasks.v2.untitled) });
    if (res.e || !res.d) return;
    patchParams((params) => {
      params.set('stage', SHOW_ALL);
      params.delete('q');
    });
    setExpandedId(res.d.id);
    setFreshId(res.d.id);
  };

  const tasks = useMemo(() => tasksData?.data ?? [], [tasksData]);
  // The search narrows the FULL set; the strip's funnel counts read this set,
  // so search shrinks the funnel but selecting a stage never zeroes the others.
  const searchFiltered = useMemo(() => filterTasks(tasks, { query }), [tasks, query]);
  const counts = useMemo(() => {
    const c: Partial<Record<TaskStatus, number>> = {};
    for (const task of searchFiltered) c[task.status] = (c[task.status] ?? 0) + 1;
    return c;
  }, [searchFiltered]);

  // The board itself shows the search survivors further narrowed to the selected
  // stage. Everything below — the area sections and their rollups — derives from
  // `filtered`, so each section's counts reflect the active filter, not the
  // full list.
  const filtered = useMemo(() => filterTasks(searchFiltered, { stage }), [searchFiltered, stage]);
  const areaGroups = useMemo(() => groupTasksByArea(filtered), [filtered]);

  // The merge-debt gate reflects the PROJECT, not the view: it counts the full
  // set so a stage/search filter can never hide the pause or its merge
  // candidates.
  const approvedCount = tasks.filter((task) => task.status === 'approved').length;
  // Drafts in the whole project — the count the cog's "Mark all as ready"
  // confirm shows. Reads the full set, so a stage/search filter never skews it.
  const draftCount = tasks.filter((task) => task.status === 'draft').length;
  const mergeCandidates = tasks.filter(
    (task) => task.status === 'approved' && task.ciState !== 'failing',
  );

  // Sequential on purpose: each merge moves main, so the next branch's CI
  // result belongs to the new base. A failure stops the walk with its error.
  const mergeAllGreen = async () => {
    for (const candidate of mergeCandidates) {
      const res = await merge.execute({ id: candidate.id });
      if (res.e) {
        toast.error(`${candidate.title}: ${t(res.e.message)}`);
        return;
      }
      toast.success(`${candidate.title} — ${t(k.tasks.v2.mergedToast)}`);
    }
  };

  if (isLoading || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const readOnly = Boolean(project.archivedAt);

  return (
    <ProjectReadOnlyContext.Provider value={readOnly}>
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Link to="/projects" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t(k.tasks.projects)}
        </Link>
      </div>

      {/* Archived: the whole page is a reading surface until unarchived. */}
      {readOnly && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          <Archive className="size-4 shrink-0" />
          <span>{t(k.tasks.archivedBanner)}</span>
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={unarchive.isLoading}
              onClick={() => void unarchive.execute({ id: project.id })}
            >
              <ArchiveRestore className="size-4 mr-1" />
              {t(k.tasks.unarchiveProject)}
            </Button>
          )}
        </div>
      )}

      <ProjectHeader
        project={project}
        readOnly={readOnly}
        actions={
          readOnly ? null : (
            <div className="flex items-center gap-2">
              <Button onClick={() => void newTask()} disabled={create.isLoading}>
                <Plus className="size-4 mr-1" />
                {t(k.tasks.newTask)}
              </Button>
              {/* The project-wide bulk sweep — Mark all drafts ready. */}
              <ProjectMarkReadyMenu projectId={project.id} draftCount={draftCount} />
            </div>
          )
        }
      />

      <ProjectContextSection project={project} readOnly={readOnly} />

      <EnvironmentsSection projectId={project.id} />

      {tasksLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* One control row: the pipeline strip (funnel + status filter) on
              the left, the title search on the right. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <PipelineStrip counts={counts} selected={stage} onSelect={setStage} />
            <TaskSearch query={query} onQueryChange={setQuery} />
          </div>

          {/* The merge-debt gate, visible where it jams. */}
          {!readOnly && approvedCount >= MERGE_DEBT_CAP && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200">
              <Pause className="size-4 shrink-0" />
              <span>{t(k.tasks.v2.dispatchPaused, { count: approvedCount })}</span>
              {mergeCandidates.length > 0 && (
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={merge.isLoading}
                  onClick={() => void mergeAllGreen()}
                >
                  <GitMerge className="size-4 mr-1" />
                  {t(k.tasks.actions.mergeAllGreen)}
                </Button>
              )}
            </div>
          )}

          {/* The board: always one collapsible section per feature area, each
              with its status rollup; rows wear their area as a chip. */}
          <ShowAreaChipContext.Provider value={true}>
            {areaGroups.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                {t(k.tasks.v2.stageEmpty.generic)}
              </p>
            ) : (
              <div className="space-y-3">
                {areaGroups.map(([key, groupTasks]) => {
                  const collapsed = collapsedAreas.has(key);
                  return (
                    <div
                      key={key || '__no_area__'}
                      className="overflow-hidden rounded-xl border bg-card shadow-xs"
                    >
                      <div className="flex w-full items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/40">
                        <button
                          type="button"
                          onClick={() => toggleArea(key)}
                          aria-expanded={!collapsed}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        >
                          <ChevronRight
                            className={cn(
                              'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
                              !collapsed && 'rotate-90',
                            )}
                          />
                          <span className="truncate text-sm font-medium">
                            {key || t(k.tasks.noArea)}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {groupTasks.length}
                          </span>
                          <span className="ml-auto shrink-0">
                            <RollupBar roll={rollupOf(groupTasks)} />
                          </span>
                        </button>
                        {/* Right-aligned per-group settings: Mark all in this
                            group as ready (prereqs from other groups pulled in). */}
                        {!readOnly && (
                          <GroupMarkReadyMenu
                            projectId={project.id}
                            area={key || null}
                            draftCount={groupTasks.filter((gt) => gt.status === 'draft').length}
                          />
                        )}
                      </div>
                      {!collapsed && (
                        <div className="divide-y border-t">
                          {groupTasks.map((task: Task) => {
                            const RowCard = cardFor(task.status);
                            return (
                              <RowCard
                                key={task.id}
                                task={task}
                                expanded={expandedId === task.id}
                                freshlyCreated={freshId === task.id}
                                onToggle={toggleExpanded}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </ShowAreaChipContext.Provider>
        </>
      )}

    </div>
    </ProjectReadOnlyContext.Provider>
  );
}
