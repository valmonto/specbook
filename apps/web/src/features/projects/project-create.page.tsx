import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import {
  ArrowLeft,
  Check,
  FolderKanban,
  GitBranch,
  Loader2,
  Lock,
  LockOpen,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { ProjectMode } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/shared/auth/auth-context';
import { useGithubRepoBranches, useGithubStatus } from '@/shared/github/use-github';
import { useCreateProject } from './hooks/use-projects';

const MANUAL = 'manual-url';
const CREATE_NEW = 'create-new';

/** GitHub repo-name shape, mirrored from the contracts schema. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const repoNameInvalid = (name: string) =>
  name.length > 0 && (!REPO_NAME_RE.test(name) || name === '.' || name === '..');

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

const SECTION =
  'text-xs font-medium tracking-wide text-muted-foreground uppercase';
const SEAMLESS_INPUT =
  'w-full rounded-md bg-transparent px-1.5 py-1 text-sm outline-none transition-colors hover:bg-muted/40 focus:bg-muted/50';

/**
 * Project creation as a page, not a dialog: identity on top (name, repo,
 * branch, workdir, automation), constitution below (the context document at
 * full height). The inputs share the seamless style of inline editing, but
 * creation stays a single explicit Create — a project with a wrong repo
 * binding is provisioned infrastructure, not an "Untitled" draft.
 */
export default function ProjectCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const github = useGithubStatus(user?.orgId);
  const create = useCreateProject();

  const [name, setName] = useState('');
  const [repoChoice, setRepoChoice] = useState<string>(MANUAL);
  const [repoUrl, setRepoUrl] = useState('');
  const [newRepoName, setNewRepoName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [fromTemplate, setFromTemplate] = useState(true);
  const [branch, setBranch] = useState('main');
  const [workdirLocked, setWorkdirLocked] = useState(true);
  const [workdirCustom, setWorkdirCustom] = useState('');
  const [mode, setMode] = useState<ProjectMode>('manual');
  const [maxParallel, setMaxParallel] = useState('1');
  const [context, setContext] = useState('');

  const repos = github.data?.connected ? github.data.repositories : [];
  const canCreateRepo = Boolean(github.data?.canCreateRepos);
  const templateRepo = github.data?.templateRepo ?? null;
  const creating = repoChoice === CREATE_NEW;
  const pickedRepo = useMemo(
    () => repos.find((r) => String(r.id) === repoChoice) ?? null,
    [repos, repoChoice],
  );

  // Branches load live once an existing repo is picked; its default wins
  // unless the user picks another.
  const branches = useGithubRepoBranches(user?.orgId, pickedRepo?.id ?? null);
  const branchOptions = branches.data?.branches ?? [];

  const pickRepo = (value: string) => {
    setRepoChoice(value);
    const repo = repos.find((r) => String(r.id) === value);
    if (repo) setBranch(repo.defaultBranch);
    if (value === CREATE_NEW) {
      setBranch('main');
      if (!newRepoName) setNewRepoName(slugify(name));
    }
    if (value === MANUAL) setBranch('main');
  };

  // Workdir follows the repo identity while locked; unlocking freezes it
  // into a plain editable value.
  const repoShort = creating
    ? newRepoName.trim()
    : (pickedRepo?.fullName.split('/')[1] ??
      repoUrl.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') ??
      '');
  const derivedWorkdir = repoShort ? `/opt/${repoShort}` : '';
  const workdir = workdirLocked ? derivedWorkdir : workdirCustom;

  const newNameInvalid = creating && nameTouched && repoNameInvalid(newRepoName.trim());
  const repoReady = creating
    ? newRepoName.trim().length > 0 && !repoNameInvalid(newRepoName.trim())
    : true;
  const canSubmit = name.trim().length > 0 && repoReady && !create.isLoading;

  const submit = async () => {
    const res = await create.execute({
      name: name.trim(),
      defaultBranch: branch.trim() || undefined,
      workdir: workdir.trim() || undefined,
      context: context.trim() || undefined,
      mode,
      maxParallel:
        mode === 'manual' ? null : Math.max(1, Math.min(10, Number(maxParallel) || 1)),
      ...(creating
        ? {
            newRepoName: newRepoName.trim(),
            newRepoFromTemplate: Boolean(templateRepo) && fromTemplate,
          }
        : pickedRepo
          ? { githubRepoId: pickedRepo.id }
          : { repoUrl: repoUrl.trim() || undefined }),
    });
    if (!res.e && res.d) navigate(`/projects/${res.d.id}`);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/projects" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t(k.tasks.projects)}
        </Link>
      </div>

      <div className="flex items-start gap-3">
        <span className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FolderKanban className="size-4.5" />
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t(k.tasks.projectName)}
          className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
        />
      </div>

      {/* Repository */}
      <section className="grid gap-2">
        <h4 className={SECTION}>{t(k.tasks.repository)}</h4>
        <Select value={repoChoice} onValueChange={pickRepo}>
          <SelectTrigger className="max-w-md">
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
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/…"
            className={cn(SEAMLESS_INPUT, 'max-w-md font-mono text-xs')}
          />
        )}

        {creating && (
          <div className="grid max-w-md gap-2 rounded-lg border bg-muted/30 p-3">
            <label className="grid gap-1.5 text-xs">
              {t(k.tasks.repoNewName)}
              <input
                value={newRepoName}
                onChange={(e) => {
                  setNewRepoName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder={slugify(name) || 'my-product'}
                className={cn(
                  SEAMLESS_INPUT,
                  'bg-background font-mono',
                  newNameInvalid && 'ring-1 ring-destructive/50',
                )}
              />
            </label>
            {newNameInvalid && (
              <p className="text-xs text-destructive">{t(k.tasks.errors.repoNameInvalid)}</p>
            )}
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

        {/* Provisioning errors land HERE, next to what caused them. */}
        {create.error && (
          <p className="max-w-md text-xs text-destructive">{t(create.error.message)}</p>
        )}
      </section>

      {/* Branch: real branches for an existing repo; main for a new one. */}
      <section className="grid gap-2">
        <h4 className={SECTION}>{t(k.tasks.defaultBranch)}</h4>
        {pickedRepo ? (
          branches.isLoading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : branchOptions.length > 0 ? (
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branchOptions.map((b) => (
                  <SelectItem key={b} value={b}>
                    <span className="flex items-center gap-1.5 font-mono text-xs">
                      <GitBranch className="size-3" />
                      {b}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className={cn(SEAMLESS_INPUT, 'w-56 font-mono text-xs')}
            />
          )
        ) : (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
            <GitBranch className="size-3" />
            {branch}
          </span>
        )}
      </section>

      {/* Workdir: derived from the repo name, unlockable. */}
      <section className="grid gap-2">
        <h4 className={SECTION}>{t(k.tasks.workdir)}</h4>
        <div className="flex max-w-md items-center gap-1.5">
          {workdirLocked ? (
            <span
              className={cn(
                'flex-1 rounded-md bg-muted/60 px-2 py-1 font-mono text-xs',
                derivedWorkdir ? 'text-muted-foreground' : 'text-muted-foreground/50 italic',
              )}
            >
              {derivedWorkdir || '/opt/…'}
            </span>
          ) : (
            <input
              autoFocus
              value={workdirCustom}
              onChange={(e) => setWorkdirCustom(e.target.value)}
              placeholder="/opt/…"
              className={cn(SEAMLESS_INPUT, 'flex-1 font-mono text-xs')}
            />
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground"
            title={t(k.tasks.workdirHint)}
            onClick={() => {
              if (workdirLocked) setWorkdirCustom(derivedWorkdir);
              setWorkdirLocked((l) => !l);
            }}
          >
            {workdirLocked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(k.tasks.workdirHint)}</p>
      </section>

      {/* Automation */}
      <section className="grid gap-2">
        <h4 className={SECTION}>{t(k.tasks.mode.label)}</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['manual', 'auto_merge', 'auto'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                mode === m
                  ? 'bg-primary/10 text-foreground ring-1 ring-primary/40'
                  : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              {m !== 'manual' && <Zap className="size-3" />}
              {t(k.tasks.mode[m])}
              {mode === m && <Check className="size-3.5 text-primary" />}
            </button>
          ))}
          {mode !== 'manual' && (
            <label className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
              {t(k.tasks.mode.maxParallel)}
              <input
                type="number"
                min={1}
                max={10}
                value={maxParallel}
                onChange={(e) => setMaxParallel(e.target.value)}
                className="w-14 rounded-md bg-muted/60 px-1.5 py-1 text-right text-xs tabular-nums outline-none focus:bg-muted"
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
        </p>
      </section>

      {/* The constitution — the most important field gets the most room. */}
      <section className="grid gap-2">
        <h4 className={SECTION}>{t(k.tasks.contextDoc)}</h4>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder={t(k.tasks.contextDocHint)}
          rows={Math.min(30, Math.max(10, context.split('\n').length))}
          className="-mx-1.5 w-[calc(100%+0.75rem)] resize-none rounded-md px-1.5 py-1 font-mono text-xs leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/50 hover:bg-muted/30 focus:bg-muted/40"
        />
      </section>

      <div className="flex items-center gap-3 border-t pt-4">
        <Button disabled={!canSubmit} onClick={() => void submit()}>
          {create.isLoading && <Loader2 className="size-4 mr-1 animate-spin" />}
          {t(k.common.actions.create)}
        </Button>
        {!canSubmit && !create.isLoading && (
          <span className="text-xs text-muted-foreground">
            {!name.trim()
              ? t(k.tasks.projectName)
              : creating
                ? t(k.tasks.repoNewName)
                : null}
          </span>
        )}
      </div>
    </div>
  );
}
