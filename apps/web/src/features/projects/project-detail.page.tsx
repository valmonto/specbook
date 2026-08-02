import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ArrowLeft, FolderKanban, GitMerge, Pause, Pencil, Plus } from 'lucide-react';
import { MERGE_DEBT_CAP, type Task, type TaskStatus } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/shared/components/page-header';
import { ProjectFormDialog } from './components/project-form-dialog';
import { PipelineStrip } from './components/v2/pipeline-strip';
import { ApprovedCard, BlockedCard, PlainCard, ReviewCard } from './components/v2/stage-cards';
import { useCreateTask, useMergeTask, useProject, useProjectTasks } from './hooks/use-projects';

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

export default function ProjectDetailV2Page() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project, isLoading } = useProject(projectId ?? null);
  const { data: tasksData, isLoading: tasksLoading } = useProjectTasks(projectId ?? null);
  const merge = useMergeTask();
  const create = useCreateTask();

  const [editOpen, setEditOpen] = useState(false);
  const [stage, setStageState] = useState<TaskStatus | null>(null);
  // One card expanded at a time — the accordion state the cards share.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The just-created draft: its row mounts with the title already in edit mode.
  const [freshId, setFreshId] = useState<string | null>(null);

  const setStage = (next: TaskStatus) => {
    setStageState(next);
    setExpandedId(null);
  };
  const toggleExpanded = (id: string) => setExpandedId((prev) => (prev === id ? null : id));

  // Creation IS editing: make the draft immediately, land on it expanded with
  // the title focused — no form, no dialog. Capture is frictionless by
  // design; the dispatch gate keeps quality at the ready boundary.
  const newTask = async () => {
    if (!project) return;
    const res = await create.execute({ projectId: project.id, title: t(k.tasks.v2.untitled) });
    if (res.e || !res.d) return;
    setStageState('draft');
    setExpandedId(res.d.id);
    setFreshId(res.d.id);
  };

  const tasks = useMemo(() => tasksData?.data ?? [], [tasksData]);
  const counts = useMemo(() => {
    const c: Partial<Record<TaskStatus, number>> = {};
    for (const task of tasks) c[task.status] = (c[task.status] ?? 0) + 1;
    return c;
  }, [tasks]);

  const selected = stage ?? smartDefault(counts);
  // Newest first: most recent stage entry on top (done = latest merged first).
  const stageTasks = tasks
    .filter((task) => task.status === selected)
    .sort(
      (a, b) =>
        new Date(b.statusChangedAt ?? b.createdAt).getTime() -
        new Date(a.statusChangedAt ?? a.createdAt).getTime(),
    );
  const approvedCount = counts.approved ?? 0;
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

  const Card =
    selected === 'needs_review' ? ReviewCard : selected === 'approved' ? ApprovedCard : selected === 'blocked' ? BlockedCard : PlainCard;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Link to="/projects" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t(k.tasks.projects)}
        </Link>
      </div>

      <PageHeader
        icon={FolderKanban}
        title={project.name}
        description={project.repoUrl ?? undefined}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4 mr-1" />
              {t(k.common.actions.edit)}
            </Button>
            <Button onClick={() => void newTask()} disabled={create.isLoading}>
              <Plus className="size-4 mr-1" />
              {t(k.tasks.newTask)}
            </Button>
          </div>
        }
      />

      {tasksLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <PipelineStrip counts={counts} selected={selected} onSelect={setStage} />

          {/* The merge-debt gate, visible where it jams. */}
          {approvedCount >= MERGE_DEBT_CAP && (
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

          {stageTasks.length === 0 ? (
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

      <ProjectFormDialog open={editOpen} onOpenChange={setEditOpen} project={project} />
    </div>
  );
}
