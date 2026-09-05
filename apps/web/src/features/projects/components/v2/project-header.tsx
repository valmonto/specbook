import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Check,
  ChevronRight,
  ExternalLink,
  FolderKanban,
  GitBranch,
  Lock,
  Pause,
  Play,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import type { Project, ProjectMode } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/shared/auth/auth-context';
import { useGithubStatus } from '@/shared/github/use-github';
import { useResumeProject, useUpdateProject } from '../../hooks/use-projects';

/**
 * The project header IS the edit surface — the last edit dialog is gone.
 * Title renames in place; repo, branch, automation and workdir are chips
 * that read at a glance and change where they are read (popover for the
 * repo picker and the mode dial, inline inputs for the rest). The strip
 * below answers "what's happening"; this row answers "what is this and
 * how is it wired".
 */

/** Optimistic display value: the save shows immediately, server truth or an error replaces it. */
function useOptimistic<T>(serverValue: T): [T, (next: T | undefined) => void] {
  const [pending, setPending] = useState<T | undefined>(undefined);
  useEffect(() => {
    if (pending !== undefined && serverValue === pending) setPending(undefined);
  }, [serverValue, pending]);
  return [pending !== undefined ? pending : serverValue, setPending];
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

export function ProjectHeader({
  project,
  actions,
  readOnly = false,
}: {
  project: Project;
  actions?: React.ReactNode;
  /** Archived project: every inline edit surface renders as plain text. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const update = useUpdateProject();
  const resume = useResumeProject();
  const github = useGithubStatus(user?.orgId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [shownTitle, setOptimisticTitle] = useOptimistic(project.name);
  const [editingBranch, setEditingBranch] = useState(false);
  const [branchDraft, setBranchDraft] = useState('');
  const [shownBranch, setOptimisticBranch] = useOptimistic(project.defaultBranch);
  const [editingWorkdir, setEditingWorkdir] = useState(false);
  const [workdirDraft, setWorkdirDraft] = useState('');
  const [shownWorkdir, setOptimisticWorkdir] = useOptimistic(project.workdir);
  const [repoOpen, setRepoOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [maxParallel, setMaxParallel] = useState(String(project.maxParallel ?? 1));
  useEffect(() => setMaxParallel(String(project.maxParallel ?? 1)), [project.maxParallel]);
  // Dollars in the input, cents in the API — empty clears the cap.
  const [budget, setBudget] = useState(
    project.budgetUsdCents === null ? '' : String(project.budgetUsdCents / 100),
  );
  useEffect(
    () => setBudget(project.budgetUsdCents === null ? '' : String(project.budgetUsdCents / 100)),
    [project.budgetUsdCents],
  );

  const save = async (patch: Record<string, unknown>, revert: () => void): Promise<void> => {
    const res = await update.execute({ id: project.id, ...patch });
    if (res.e) {
      revert();
      toast.error(t(res.e.message));
    }
  };

  const saveTitle = () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!next || next === project.name) return;
    setOptimisticTitle(next);
    void save({ name: next }, () => setOptimisticTitle(undefined));
  };
  const saveBranch = () => {
    setEditingBranch(false);
    const next = branchDraft.trim();
    if (!next || next === project.defaultBranch) return;
    setOptimisticBranch(next);
    void save({ defaultBranch: next }, () => setOptimisticBranch(undefined));
  };
  const saveWorkdir = () => {
    setEditingWorkdir(false);
    const next = workdirDraft.trim() || null;
    if (next === project.workdir) return;
    setOptimisticWorkdir(next);
    void save({ workdir: next }, () => setOptimisticWorkdir(undefined));
  };
  const setMode = (mode: ProjectMode) => {
    setModeOpen(false);
    if (mode === project.mode) return;
    void save(
      {
        mode,
        maxParallel: mode === 'manual' ? null : Math.max(1, Math.min(10, Number(maxParallel) || 1)),
      },
      () => {},
    );
  };
  const pickRepo = (repoId: number | null) => {
    setRepoOpen(false);
    if (repoId === project.githubRepoId) return;
    void save({ githubRepoId: repoId }, () => {});
  };

  const repos = github.data?.connected ? github.data.repositories : [];
  const modeLabel = {
    manual: k.tasks.mode.manual,
    auto_merge: k.tasks.mode.auto_merge,
    auto: k.tasks.mode.auto,
  }[project.mode];
  const modeHint = {
    manual: k.tasks.mode.manualHint,
    auto_merge: k.tasks.mode.autoMergeHint,
    auto: k.tasks.mode.autoHint,
  }[project.mode];

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FolderKanban className="size-4.5" />
        </span>
        <div className="min-w-0">
          {/* Title: click to rename, Notion-style. */}
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="w-full border-b border-primary/40 bg-transparent text-xl font-semibold tracking-tight outline-none"
            />
          ) : readOnly ? (
            <span className="truncate text-left text-xl font-semibold tracking-tight">
              {shownTitle}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTitleDraft(shownTitle);
                setEditingTitle(true);
              }}
              className="cursor-text truncate text-left text-xl font-semibold tracking-tight"
            >
              {shownTitle}
            </button>
          )}

          {/* Config chips: read at a glance, change where they are read. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Popover open={repoOpen} onOpenChange={readOnly ? undefined : setRepoOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={cn(CHIP, 'font-mono')}>
                  <GitBranch className="size-3" />
                  {project.githubRepoFullName ??
                    project.repoUrl?.replace(/^https:\/\/github\.com\//, '') ??
                    t(k.tasks.repoPickerPlaceholder)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-2">
                <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                  {t(k.tasks.repoUrl)}
                </p>
                <div className="grid max-h-64 gap-0.5 overflow-y-auto">
                  {repos.map((repo) => (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => pickRepo(repo.id)}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono text-xs">
                        {repo.fullName}
                      </code>
                      {repo.private && <Lock className="size-3 text-muted-foreground" />}
                      {project.githubRepoId === repo.id && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </button>
                  ))}
                  {repos.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      {t(k.orgs.github.noRepos)}
                    </p>
                  )}
                </div>
                {project.repoUrl && (
                  <a
                    href={project.repoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-primary hover:bg-muted"
                  >
                    <ExternalLink className="size-3" />
                    {t(k.tasks.detail.openPr).replace('PR', 'GitHub')}
                  </a>
                )}
              </PopoverContent>
            </Popover>

            {editingBranch ? (
              <input
                autoFocus
                value={branchDraft}
                onChange={(e) => setBranchDraft(e.target.value)}
                onBlur={saveBranch}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditingBranch(false);
                }}
                className="w-28 rounded-md bg-muted px-2 py-1 font-mono text-xs outline-none"
              />
            ) : (
              <button
                type="button"
                title={t(k.tasks.defaultBranch)}
                onClick={() => {
                  setBranchDraft(shownBranch);
                  if (readOnly) return;
                  setEditingBranch(true);
                }}
                className={cn(CHIP, 'font-mono')}
              >
                {shownBranch}
              </button>
            )}

            <Popover open={modeOpen} onOpenChange={readOnly ? undefined : setModeOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title={t(modeHint)}
                  className={cn(
                    CHIP,
                    project.mode !== 'manual' &&
                      'bg-violet-500/15 text-violet-700 hover:bg-violet-500/25 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-300',
                  )}
                >
                  <Zap className="size-3" />
                  {t(modeLabel)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-2">
                <div className="grid gap-0.5">
                  {(['manual', 'auto_merge', 'auto'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className="rounded-md px-2 py-1.5 text-left hover:bg-muted"
                    >
                      <span className="flex items-center gap-2 text-sm">
                        {t(k.tasks.mode[m])}
                        {project.mode === m && <Check className="size-3.5 text-primary" />}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(
                          m === 'manual'
                            ? k.tasks.mode.manualHint
                            : m === 'auto_merge'
                              ? k.tasks.mode.autoMergeHint
                              : k.tasks.mode.autoHint,
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                <label className="mt-1.5 flex items-center justify-between gap-2 border-t px-2 pt-2 text-xs text-muted-foreground">
                  {t(k.tasks.mode.maxParallel)}
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={maxParallel}
                    onChange={(e) => setMaxParallel(e.target.value)}
                    onBlur={() => {
                      if (project.mode !== 'manual') setMode(project.mode);
                    }}
                    className="h-7 w-16 text-right"
                  />
                </label>
                <label className="mt-1.5 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
                  {t(k.tasks.mode.budget)}
                  <Input
                    type="number"
                    min={0}
                    value={budget}
                    placeholder="—"
                    onChange={(e) => setBudget(e.target.value)}
                    onBlur={() => {
                      const cents =
                        budget.trim() === '' ? null : Math.max(0, Math.round(Number(budget) * 100));
                      if (cents === project.budgetUsdCents) return;
                      void save({ budgetUsdCents: cents }, () => {});
                    }}
                    className="h-7 w-20 text-right"
                  />
                </label>
              </PopoverContent>
            </Popover>

            {project.budgetUsdCents !== null && (
              <span
                className={cn(
                  'text-xs tabular-nums text-muted-foreground',
                  project.budgetPaused && 'font-medium text-amber-700 dark:text-amber-300',
                )}
              >
                {t(k.tasks.mode.spend, {
                  spent: (Math.round(project.monthSpendUsdCents ?? 0) / 100).toFixed(2),
                  budget: (project.budgetUsdCents / 100).toFixed(2),
                })}
              </span>
            )}
            {project.budgetPaused && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                <Pause className="size-3" />
                {t(k.tasks.mode.pausedBudget)}
              </span>
            )}

            {project.mode !== 'manual' && project.autoPausedAt && (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-600 dark:text-rose-300"
                title={[
                  t(k.tasks.mode.pausedHint, {
                    date: new Date(project.autoPausedAt).toLocaleString(),
                  }),
                  project.autoPausePointer ?? '',
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                <Pause className="size-3" />
                {project.autoPauseKind
                  ? t(k.tasks.mode.pausedKind, {
                      kind: t(k.tasks.ciFailureKind[project.autoPauseKind]),
                      pointer: project.autoPausePointer ?? '',
                    })
                  : t(k.tasks.mode.paused)}
                <span className="font-normal opacity-75">
                  · {new Date(project.autoPausedAt).toLocaleDateString()}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    disabled={resume.isLoading}
                    onClick={async () => {
                      const res = await resume.execute({ id: project.id });
                      if (res.e) toast.error(t(res.e.message));
                    }}
                    className="ml-1 inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 font-medium transition-colors hover:bg-rose-500/25 disabled:opacity-50"
                  >
                    <Play className="size-3" />
                    {t(k.tasks.mode.resume)}
                  </button>
                )}
              </span>
            )}

            {editingWorkdir ? (
              <input
                autoFocus
                value={workdirDraft}
                onChange={(e) => setWorkdirDraft(e.target.value)}
                onBlur={saveWorkdir}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditingWorkdir(false);
                }}
                placeholder="/opt/…"
                className="w-44 rounded-md bg-muted px-2 py-1 font-mono text-xs outline-none"
              />
            ) : (
              <button
                type="button"
                title={t(k.tasks.workdirHint)}
                onClick={() => {
                  setWorkdirDraft(shownWorkdir ?? '');
                  if (readOnly) return;
                  setEditingWorkdir(true);
                }}
                className={cn(CHIP, 'font-mono', !shownWorkdir && 'italic')}
              >
                <TerminalSquare className="size-3" />
                {shownWorkdir ?? t(k.tasks.workdir)}
              </button>
            )}
          </div>
        </div>
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The project's constitution, one click away instead of buried in a modal:
 * collapsed it is a single preview line; expanded it is the same seamless
 * inline editor tasks use. Agents read this every session — keeping it
 * visible is what keeps it maintained.
 */
export function ProjectContextSection({
  project,
  readOnly = false,
}: {
  project: Project;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateProject();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [shown, setOptimistic] = useOptimistic(project.context);

  const saveContext = () => {
    setEditing(false);
    const next = draft.trim() || null;
    if (next === project.context) return;
    setOptimistic(next);
    void update.execute({ id: project.id, context: next }).then((res) => {
      if (res.e) {
        setOptimistic(undefined);
        toast.error(t(res.e.message));
      }
    });
  };

  const preview = shown?.split('\n').find((l) => l.trim()) ?? t(k.tasks.contextDocHint);

  return (
    <div className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t(k.tasks.contextDoc)}
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
            {preview}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t px-3 py-3">
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveContext}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
              }}
              rows={Math.min(30, Math.max(6, draft.split('\n').length))}
              className="-mx-1.5 w-[calc(100%+0.75rem)] resize-none rounded-md bg-muted/40 px-1.5 py-0.5 font-mono text-xs leading-relaxed whitespace-pre-wrap outline-none [field-sizing:content]"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (readOnly) return;
                setDraft(shown ?? '');
                setEditing(true);
              }}
              className={cn(
                '-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap',
                !readOnly && 'cursor-text hover:bg-muted/50',
              )}
            >
              {shown ?? (
                <span className="text-muted-foreground/60 italic">{t(k.tasks.contextDocHint)}</span>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
