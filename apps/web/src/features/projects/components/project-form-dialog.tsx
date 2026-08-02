import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderKanban, Lock, Sparkles } from 'lucide-react';
import type { Project, ProjectMode } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WideModal } from '@/components/overlays/wide-modal';
import { useAuth } from '@/shared/auth/auth-context';
import { useGithubStatus } from '@/shared/github/use-github';
import { useCreateProject, useUpdateProject } from '../hooks/use-projects';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit mode. */
  project?: Project | null;
}

/** Sentinel for "type a URL yourself" in the repo picker. */
const MANUAL = 'manual';
/** Sentinel for "provision a brand-new repository" (create mode only). */
const CREATE_NEW = 'create-new';

/** GitHub repo-name shape, mirrored from the contracts schema. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * One modal for create and edit — same fields, different verb. WideModal (not
 * raw Dialog): the context document can be long, and its pinned header/footer
 * keep Create reachable while the body scrolls.
 *
 * The repo field has two shapes: with a GitHub connection the picker offers
 * exactly the installation's granted repos (the server re-verifies the pick
 * and derives the URL itself); without one it stays the free-text URL input.
 */
export function ProjectFormDialog({ open, onOpenChange, project }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const github = useGithubStatus(user?.orgId);
  const create = useCreateProject();
  const update = useUpdateProject();
  const busy = create.isLoading || update.isLoading;

  const [name, setName] = useState('');
  const [repoChoice, setRepoChoice] = useState<string>(MANUAL);
  const [repoUrl, setRepoUrl] = useState('');
  const [newRepoName, setNewRepoName] = useState('');
  const [fromTemplate, setFromTemplate] = useState(true);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [workdir, setWorkdir] = useState('');
  const [context, setContext] = useState('');
  const [mode, setMode] = useState<ProjectMode>('manual');
  const [maxParallel, setMaxParallel] = useState('1');

  const repos = github.data?.connected ? github.data.repositories : [];
  const pickerAvailable = repos.length > 0;
  // Provisioning: create mode only, and only when the installation granted
  // the Administration permission — otherwise the option simply is not there.
  const canCreateRepo = !project && Boolean(github.data?.canCreateRepos);
  const templateRepo = github.data?.templateRepo ?? null;
  const creating = repoChoice === CREATE_NEW;

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setRepoChoice(project?.githubRepoId ? String(project.githubRepoId) : MANUAL);
    setRepoUrl(project?.repoUrl ?? '');
    setNewRepoName('');
    setFromTemplate(true);
    setDefaultBranch(project?.defaultBranch ?? 'main');
    setWorkdir(project?.workdir ?? '');
    setContext(project?.context ?? '');
    setMode(project?.mode ?? 'manual');
    setMaxParallel(String(project?.maxParallel ?? 1));
  }, [open, project]);

  const pickRepo = (value: string) => {
    setRepoChoice(value);
    const repo = repos.find((r) => String(r.id) === value);
    if (repo) setDefaultBranch(repo.defaultBranch);
    if (value === CREATE_NEW && !newRepoName) setNewRepoName(slugify(name));
  };

  const newRepoInvalid = creating && (!newRepoName.trim() || !REPO_NAME_RE.test(newRepoName.trim()));

  const submit = async () => {
    const pickedId =
      repoChoice === MANUAL || repoChoice === CREATE_NEW ? undefined : Number(repoChoice);
    const base = {
      name: name.trim(),
      defaultBranch: defaultBranch.trim() || undefined,
      workdir: workdir.trim() || undefined,
      context: context.trim() || undefined,
      mode,
      // Auto modes default to strictly sequential claims; manual keeps the
      // runner's own concurrency (no project cap).
      maxParallel:
        mode === 'manual' ? null : Math.max(1, Math.min(10, Number(maxParallel) || 1)),
    };
    const res = project
      ? await update.execute({
          id: project.id,
          ...base,
          // Manual mode on a previously-bound project clears the binding.
          githubRepoId: pickedId ?? (project.githubRepoId ? null : undefined),
          ...(pickedId ? {} : { repoUrl: repoUrl.trim() || null }),
        })
      : await create.execute({
          ...base,
          githubRepoId: pickedId,
          ...(creating
            ? {
                newRepoName: newRepoName.trim(),
                newRepoFromTemplate: Boolean(templateRepo) && fromTemplate,
              }
            : pickedId
              ? {}
              : { repoUrl: repoUrl.trim() || undefined }),
        });
    if (!res.e) onOpenChange(false);
  };

  return (
    <WideModal
      open={open}
      onOpenChange={onOpenChange}
      icon={<FolderKanban />}
      title={t(project ? k.tasks.editProject : k.tasks.newProject)}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t(k.common.actions.cancel)}
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || newRepoInvalid}>
            {t(project ? k.common.actions.save : k.common.actions.create)}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        {/* Name + branch: two short fields of equal height share a row;
            content-start keeps label+input pinned together if a sibling ever
            grows (the stretch artifact this layout replaces). */}
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="grid content-start gap-2">
            <Label htmlFor="project-name">{t(k.tasks.projectName)}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid content-start gap-2">
            <Label htmlFor="project-branch">{t(k.tasks.defaultBranch)}</Label>
            <Input
              id="project-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
            />
          </div>
        </div>

        {/* Repository: its own full-width section — the one field whose
            height changes with the choice, so it must not share a row. */}
        <div className="grid content-start gap-2">
          <Label htmlFor="project-repo">{t(k.tasks.repoUrl)}</Label>
          {pickerAvailable || canCreateRepo ? (
            <>
              <Select value={repoChoice} onValueChange={pickRepo}>
                <SelectTrigger id="project-repo" className="max-w-md">
                  <SelectValue placeholder={t(k.tasks.repoPickerPlaceholder)} />
                </SelectTrigger>
                <SelectContent>
                  {canCreateRepo && (
                    <SelectItem value={CREATE_NEW}>
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="size-3 text-muted-foreground" />
                        {t(k.tasks.repoCreateNew)}
                      </span>
                    </SelectItem>
                  )}
                  {repos.map((repo) => (
                    <SelectItem key={repo.id} value={String(repo.id)}>
                      <span className="flex items-center gap-1.5">
                        <code className="font-mono text-xs">{repo.fullName}</code>
                        {repo.private && <Lock className="size-3 text-muted-foreground" />}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value={MANUAL}>{t(k.tasks.repoManualUrl)}</SelectItem>
                </SelectContent>
              </Select>
              {repoChoice === MANUAL && (
                <Input
                  className="max-w-md"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/…"
                />
              )}
              {creating && (
                <div className="grid max-w-md gap-2.5 rounded-lg border bg-muted/30 p-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="new-repo-name" className="text-xs">
                      {t(k.tasks.repoNewName)}
                    </Label>
                    <Input
                      id="new-repo-name"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder={slugify(name) || 'my-product'}
                    />
                  </div>
                  {templateRepo && (
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={fromTemplate}
                        onCheckedChange={(checked) => setFromTemplate(checked === true)}
                      />
                      {t(k.tasks.repoFromTemplate, { template: templateRepo })}
                    </label>
                  )}
                  <p className="text-xs text-muted-foreground">{t(k.tasks.repoCreateHint)}</p>
                </div>
              )}
            </>
          ) : (
            <Input
              id="project-repo"
              className="max-w-md"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/…"
            />
          )}
        </div>
        {/* The automation trust dial. Full auto requires CI: without ciState
            events nothing ever auto-progresses, and a red default branch
            pauses everything (the hint says so). */}
        <div className="grid gap-2">
          <Label htmlFor="project-mode">{t(k.tasks.mode.label)}</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={mode} onValueChange={(v) => setMode(v as ProjectMode)}>
              <SelectTrigger id="project-mode" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">{t(k.tasks.mode.manual)}</SelectItem>
                <SelectItem value="auto_merge">{t(k.tasks.mode.auto_merge)}</SelectItem>
                <SelectItem value="auto">{t(k.tasks.mode.auto)}</SelectItem>
              </SelectContent>
            </Select>
            {mode !== 'manual' && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                {t(k.tasks.mode.maxParallel)}
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={maxParallel}
                  onChange={(e) => setMaxParallel(e.target.value)}
                  className="w-16"
                />
              </label>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              mode === 'manual'
                ? k.tasks.mode.manualHint
                : mode === 'auto_merge'
                  ? k.tasks.mode.autoMergeHint
                  : k.tasks.mode.autoHint,
            )}
            {mode !== 'manual' && ` — ${t(k.tasks.mode.maxParallelHint)}`}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project-workdir">{t(k.tasks.workdir)}</Label>
          <Input
            id="project-workdir"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="/opt/…"
          />
          <p className="text-xs text-muted-foreground">{t(k.tasks.workdirHint)}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project-context">{t(k.tasks.contextDoc)}</Label>
          <Textarea
            id="project-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="min-h-72 font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">{t(k.tasks.contextDocHint)}</p>
        </div>
      </div>
    </WideModal>
  );
}
