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
import { GroupByControl, PipelineStrip, type GroupBy } from './components/v2/pipeline-strip';
import { byRecency, groupTasksByArea } from './components/v2/group-tasks';
import { TaskFilterBar } from './components/v2/task-filter-bar';
import {
  filterTasks,
  parseStatusFilter,
  serializeStatusFilter,
  type StatusBucket,
} from './components/v2/filter-tasks';
import { cardFor, ShowAreaChipContext } from './components/v2/stage-cards';
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
 * The project view: a pipeline strip + one stage-filtered list. Opening the
 * page lands on the first stage that needs the human (review → blocked →
 * approved), because that is the question the view exists to answer. Rows
 * expand in place to the full task detail (see v2/stage-cards).
 */
const GATE_PRIORITY: TaskStatus[] = ['needs_review', 'blocked', 'approved'];
const FALLBACK: TaskStatus[] = ['in_progress', 'ready', 'changes_requested', 'draft', 'done'];

const smartDefault = (counts: Partial<Record<TaskStatus, number>>): TaskStatus => {
  for (const s of [...GATE_PRIORITY, ...FALLBACK]) if ((counts[s] ?? 0) > 0) return s;
  return 'ready';
};

const EMPTY_KEYS: Partial<Record<TaskStatus, string>> = {
  ready: k.tasks.v2.stageEmpty.ready,
  needs_review: k.tasks.v2.stageEmpty.needs_review,
  approved: k.tasks.v2.stageEmpty.approved,
  done: k.tasks.v2.stageEmpty.done,
};

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

  // The selected stage lives in the URL (?stage=needs_review): reloads and
  // shared links restore the same pipeline column. Absent/invalid → smart
  // default below.
  const [searchParams, setSearchParams] = useSearchParams();
  const stageParam = searchParams.get('stage');
  const stage: TaskStatus | null =
    stageParam && (TASK_STATUSES as readonly string[]).includes(stageParam)
      ? (stageParam as TaskStatus)
      : null;
  // The grouping axis lives in the URL too: Area is the default (no param) —
  // the board opens grouped under feature sections — and ?group=status switches
  // back to the stage-filtered pipeline.
  const groupBy: GroupBy = searchParams.get('group') === 'status' ? 'status' : 'area';
  // The standalone filter lives in the URL too, orthogonal to group/stage:
  // ?status= (comma-separated buckets; absent = all visible, the default) and
  // ?q= (title search). Persisting here is what lets the filter survive a
  // Status↔Area switch and stay shareable. Default is show-all — the board
  // never hides work behind an unset control (a shared link shows everything).
  const statusParam = searchParams.get('status');
  const query = searchParams.get('q') ?? '';
  // Memo on the raw param strings so the filter (and everything it feeds)
  // keeps a stable identity between unrelated re-renders.
  const filter = useMemo(
    () => ({ statuses: parseStatusFilter(statusParam), query }),
    [statusParam, query],
  );
  // One card expanded at a time — the accordion state the cards share.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The just-created draft: its row mounts with the title already in edit mode.
  const [freshId, setFreshId] = useState<string | null>(null);
  // Collapsed feature sections (Area mode) — keyed by area label; '' = No area.
  const [collapsedAreas, setCollapsedAreas] = useState<Set<string>>(new Set());

  // Every setter patches the existing params (never replaces the whole set),
  // so the orthogonal controls — stage, group, and the filter — never wipe
  // one another. Passing group/stage no longer drops an active filter.
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
  const setStage = (next: TaskStatus) => {
    patchParams((params) => params.set('stage', next));
    setExpandedId(null);
  };
  const setGroup = (next: GroupBy) => {
    setExpandedId(null);
    patchParams((params) => {
      if (next === 'status') params.set('group', 'status');
      else params.delete('group');
    });
  };
  const setStatusFilter = (statuses: readonly StatusBucket[]) => {
    patchParams((params) => {
      const value = serializeStatusFilter(statuses);
      if (value === null) params.delete('status');
      else params.set('status', value);
    });
  };
  const setQuery = (next: string) => {
    patchParams((params) => {
      if (next.trim() === '') params.delete('q');
      else params.set('q', next);
    });
  };
  const resetFilter = () => {
    patchParams((params) => {
      params.delete('status');
      params.delete('q');
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
  // the title focused — no form, no dialog. Capture is frictionless by
  // design; the dispatch gate keeps quality at the ready boundary.
  const newTask = async () => {
    if (!project) return;
    const res = await create.execute({ projectId: project.id, title: t(k.tasks.v2.untitled) });
    if (res.e || !res.d) return;
    // Land on the draft stage, but keep the current grouping axis AND any
    // active filter: in Status mode that reveals the draft column, in Area
    // mode the fresh row already sits (expanded, title focused) in its area
    // section. patchParams preserves group/status/q — a new draft never wipes
    // the board's narrowing.
    patchParams((params) => params.set('stage', 'draft'));
    setExpandedId(res.d.id);
    setFreshId(res.d.id);
  };

  const tasks = useMemo(() => tasksData?.data ?? [], [tasksData]);
  // The filter narrows the FULL set FIRST; the current grouping then arranges
  // only the survivors. Everything the view shows — strip counts, the stage
  // list, the area sections and their rollups — is derived from `filtered`.
  const filtered = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const counts = useMemo(() => {
    const c: Partial<Record<TaskStatus, number>> = {};
    for (const task of filtered) c[task.status] = (c[task.status] ?? 0) + 1;
    return c;
  }, [filtered]);

  const selected = stage ?? smartDefault(counts);
  // Newest first: most recent stage entry on top (done = latest merged first).
  const stageTasks = filtered.filter((task) => task.status === selected).sort(byRecency);

  // Area mode: the filtered list, grouped under one section per area (see
  // groupTasksByArea for the ordering — named first, "No area" last). Each
  // section's rollup counts therefore reflect the filter, not the full list.
  const areaGroups = useMemo(() => groupTasksByArea(filtered), [filtered]);
  // The merge-debt gate reflects the PROJECT, not the view: it counts the full
  // set so a status filter can never hide the pause or its merge candidates.
  const approvedCount = tasks.filter((task) => task.status === 'approved').length;
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

  const Card = cardFor(selected);

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
            <Button onClick={() => void newTask()} disabled={create.isLoading}>
              <Plus className="size-4 mr-1" />
              {t(k.tasks.newTask)}
            </Button>
          )
        }
      />

      <ProjectContextSection project={project} readOnly={readOnly} />

      <EnvironmentsSection projectId={project.id} />

      {tasksLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* Stage strip (Status mode) and the Group by: Status | Area
              control sit on one row; in Area mode the strip gives way to the
              feature sections below. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {groupBy === 'status' ? (
              <PipelineStrip counts={counts} selected={selected} onSelect={setStage} />
            ) : (
              <span />
            )}
            <GroupByControl value={groupBy} onChange={setGroup} />
          </div>

          {/* The standalone filter — orthogonal to group-by, applies in both
              modes and persists across a switch. */}
          <TaskFilterBar
            filter={filter}
            onStatusesChange={setStatusFilter}
            onQueryChange={setQuery}
            onReset={resetFilter}
          />

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

          {groupBy === 'area' ? (
            // Area mode: one collapsible section per feature, each with its
            // status rollup; rows wear their area as a chip.
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
                        <button
                          type="button"
                          onClick={() => toggleArea(key)}
                          aria-expanded={!collapsed}
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
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
          ) : stageTasks.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              {t(EMPTY_KEYS[selected] ?? k.tasks.v2.stageEmpty.generic)}
            </p>
          ) : (
            <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
              {stageTasks.map((task: Task) => (
                <Card
                  key={task.id}
                  task={task}
                  expanded={expandedId === task.id}
                  freshlyCreated={freshId === task.id}
                  onToggle={toggleExpanded}
                />
              ))}
            </div>
          )}
        </>
      )}

    </div>
    </ProjectReadOnlyContext.Provider>
  );
}
