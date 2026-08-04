import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ChevronRight,
  ExternalLink,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
} from 'lucide-react';
import { ENVIRONMENT_NAMES, type Environment, type EnvironmentName } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCan } from '@/shared/hooks/use-permissions';
import { useServers } from '@/shared/servers/hooks';
import { useProjectReadOnly } from './v2/read-only-context';
import { Switch } from '@/components/ui/switch';
import {
  useCreateEnvironment,
  useDeleteEnvVar,
  useDeployEnvironment,
  useEnvironments,
  useProvisionEnvironment,
  useRemoveEnvironment,
  useSetEnvVar,
  useUpdateEnvironment,
} from '../hooks/use-environments';

const provisionStyles: Record<Environment['provisionStatus'], string> = {
  unprovisioned: 'bg-muted text-muted-foreground',
  provisioning: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  provisioned: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
};

const provisionLabels: Record<Environment['provisionStatus'], string> = {
  unprovisioned: k.environments.provisionStatus.unprovisioned,
  provisioning: k.environments.provisionStatus.provisioning,
  provisioned: k.environments.provisionStatus.provisioned,
  failed: k.environments.provisionStatus.failed,
};

const deploymentStyles: Record<NonNullable<Environment['latestDeployment']>['status'], string> = {
  queued: 'bg-muted text-muted-foreground',
  building: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  deploying: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  healthy: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
};

const deploymentLabels: Record<NonNullable<Environment['latestDeployment']>['status'], string> = {
  queued: k.environments.deploymentStatus.queued,
  building: k.environments.deploymentStatus.building,
  deploying: k.environments.deploymentStatus.deploying,
  healthy: k.environments.deploymentStatus.healthy,
  failed: k.environments.deploymentStatus.failed,
};

/** "2m ago"-class recency, coarse on purpose. */
const ago = (iso: string): string => {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** Running-time display: "40s", then "3m 40s" — the anti-"still building?" line. */
const elapsed = (iso: string): string => {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

const phaseLabels: Record<NonNullable<NonNullable<Environment['latestDeployment']>['phase']>, string> = {
  resolve: k.environments.deploymentPhase.resolve,
  build: k.environments.deploymentPhase.build,
  transfer: k.environments.deploymentPhase.transfer,
  render: k.environments.deploymentPhase.render,
  up: k.environments.deploymentPhase.up,
};

/**
 * The Environments section of the project page: where this project RUNS.
 * Platform vars render read-only (machine-owned wiring); user secrets render
 * as NAMES with set/replace/delete only — a value, once written, never
 * appears in any response, so there is nothing to show.
 */
export function EnvironmentsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const readOnly = useProjectReadOnly();
  const canManage = useCan('project:update') && !readOnly;
  const { data } = useEnvironments(projectId);
  const environments = data?.data ?? [];

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

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
          {t(k.environments.title)}
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
            {environments.length
              ? environments.map((e) => e.name).join(' · ')
              : t(k.environments.empty)}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          {environments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(k.environments.empty)}</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {environments.map((env) => (
                <EnvironmentRow
                  key={env.id}
                  env={env}
                  projectId={projectId}
                  canManage={canManage}
                />
              ))}
            </div>
          )}
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-4 mr-1" />
              {t(k.environments.addEnvironment)}
            </Button>
          )}
          <AddEnvironmentDialog
            projectId={projectId}
            open={adding}
            onOpenChange={setAdding}
            taken={environments.map((e) => e.name)}
          />
        </div>
      )}
    </div>
  );
}

function EnvironmentRow({
  env,
  projectId,
  canManage,
}: {
  env: Environment;
  projectId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const remove = useRemoveEnvironment(projectId);
  const provision = useProvisionEnvironment(projectId);
  const deploy = useDeployEnvironment(projectId);

  const platformNames = Object.keys(env.platformEnv).sort();
  const latest = env.latestDeployment;
  const deployInFlight = latest?.status === 'queued' || latest?.status === 'building' || latest?.status === 'deploying';
  // The newest output is the interesting end — keep the tail in view.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [latest?.log, showLog]);
  const runProvision = () =>
    void provision.execute({ projectId, id: env.id }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });
  const runDeploy = () =>
    void deploy.execute({ projectId, id: env.id }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        {/* role=button instead of <button>: the domain chip nests a real <a>,
            which HTML forbids inside a native button. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((e) => !e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded((x) => !x);
            }
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span className="text-sm font-medium">{env.name}</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
            <HardDrive className="size-3" />
            {env.serverName}
          </span>
          {env.domain &&
            (env.publicUrl === `https://${env.domain}` ? (
              <a
                href={env.publicUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 hover:underline dark:text-emerald-400"
              >
                <Globe className="size-3" />
                <span className="truncate font-mono">{env.domain}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                <Globe className="size-3" />
                <span className="truncate font-mono">{env.domain}</span>
                {env.domainPending && (
                  <span className="text-amber-700 dark:text-amber-400">
                    · {t(k.environments.domainPending)}
                  </span>
                )}
              </span>
            ))}
          <AutoDeployChip env={env} projectId={projectId} canManage={canManage} />
          <span
            className={cn(
              'inline-flex items-center rounded-md px-2 py-0.5 text-xs',
              provisionStyles[env.provisionStatus],
            )}
          >
            {t(provisionLabels[env.provisionStatus])}
          </span>
          {latest && (
            <span
              role={latest.log || deployInFlight ? 'button' : undefined}
              title={
                latest.log || deployInFlight
                  ? t(showLog ? k.environments.hideLog : k.environments.showLog)
                  : undefined
              }
              onClick={(e) => {
                if (!latest.log && !deployInFlight) return;
                e.stopPropagation();
                setShowLog((s) => !s);
              }}
              className={cn(
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs',
                deploymentStyles[latest.status],
                (latest.log || deployInFlight) && 'cursor-pointer hover:opacity-80',
              )}
            >
              {deployInFlight
                ? `${t(latest.phase ? phaseLabels[latest.phase] : deploymentLabels[latest.status])} · ${elapsed(latest.startedAt ?? latest.createdAt)}`
                : t(deploymentLabels[latest.status])}
            </span>
          )}
          {latest?.sha && latest.status === 'healthy' && (
            <span
              role={latest.log ? 'button' : undefined}
              title={latest.log ? t(showLog ? k.environments.hideLog : k.environments.showLog) : undefined}
              onClick={(e) => {
                if (!latest.log) return;
                e.stopPropagation();
                setShowLog((s) => !s);
              }}
              className={cn('text-xs text-muted-foreground', latest.log && 'cursor-pointer hover:text-foreground')}
            >
              {t(k.environments.deployedLine, {
                sha: latest.sha.slice(0, 7),
                ago: ago(latest.finishedAt ?? latest.createdAt),
              })}
            </span>
          )}
        </div>
        {env.publicUrl && (
          <a
            href={env.publicUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            {t(k.environments.openStaging)}
          </a>
        )}
        {canManage && env.provisionStatus === 'provisioned' && !deployInFlight && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            disabled={deploy.isLoading}
            onClick={runDeploy}
          >
            <Rocket className="size-3" />
            {t(k.environments.deployAction)}
          </Button>
        )}
        {canManage && env.provisionStatus !== 'provisioning' && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            disabled={provision.isLoading}
            onClick={runProvision}
          >
            <RefreshCw className="size-3" />
            {t(
              env.provisionStatus === 'unprovisioned'
                ? k.environments.provisionAction
                : k.environments.reprovisionAction,
            )}
          </Button>
        )}
        {canManage && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t(k.environments.removeEnvironment)}
            className="size-7 text-muted-foreground"
            onClick={() => setConfirmingRemove(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {latest?.status === 'failed' && latest.error && (
        <p className="border-t bg-rose-500/5 px-3 py-1.5 font-mono text-xs whitespace-pre-wrap text-rose-700 dark:text-rose-400">
          {latest.error.includes('.') && !latest.error.includes(' ')
            ? t(latest.error)
            : latest.error.slice(0, 400)}
        </p>
      )}
      {showLog && latest && (
        <pre
          ref={logRef}
          className="max-h-64 overflow-auto border-t bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-300"
        >
          {latest.log || t(k.environments.logEmpty)}
        </pre>
      )}
      {env.autoDeployPaused && (
        <p className="border-t bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          {t(k.environments.autoDeployPausedWarning)}
        </p>
      )}
      {env.provisionStatus === 'failed' && env.provisionError && (
        <p className="border-t bg-rose-500/5 px-3 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          {env.provisionError.includes('.') && !env.provisionError.includes(' ')
            ? t(env.provisionError)
            : env.provisionError}
        </p>
      )}

      {expanded && (
        <div className="space-y-4 border-t bg-muted/20 px-3 py-3">
          {env.deployPath && (
            <p className="text-xs text-muted-foreground">
              {t(k.environments.deployPath)}: <span className="font-mono">{env.deployPath}</span>
            </p>
          )}

          {/* Platform vars: machine wiring, read-only by design. */}
          <div className="space-y-1.5">
            <p className="inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <Lock className="size-3" />
              {t(k.environments.platformEnvTitle)}
            </p>
            <p className="text-xs text-muted-foreground/70">{t(k.environments.platformEnvHint)}</p>
            {platformNames.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t(k.environments.platformEnvEmpty)}</p>
            ) : (
              <div className="rounded-md border bg-card font-mono text-xs">
                {platformNames.map((name) => (
                  <div key={name} className="flex gap-2 border-b px-2 py-1 last:border-b-0">
                    <span className="shrink-0 text-muted-foreground">{name}=</span>
                    <span className="truncate">{env.platformEnv[name]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <UserEnvEditor env={env} projectId={projectId} canManage={canManage} />
        </div>
      )}

      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.environments.removeConfirmTitle)}</AlertDialogTitle>
            <AlertDialogDescription>{t(k.environments.removeConfirmBody)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() =>
                void remove.execute({ projectId, id: env.id }).then((res) => {
                  if (res.e) toast.error(t(res.e.message));
                  else setConfirmingRemove(false);
                })
              }
            >
              {t(k.environments.removeEnvironment)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Secrets: names are listed, values are write-only. The single form both
 * creates a new var and replaces an existing one (same NAME = replace).
 */
/**
 * The auto-deploy toggle lives ON the chip: on = colored, off = muted, and
 * clicking flips the flag (managers only; disabled until provisioned).
 */
function AutoDeployChip({
  env,
  projectId,
  canManage,
}: {
  env: Environment;
  projectId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateEnvironment(projectId);
  const provisioned = env.provisionStatus === 'provisioned';
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canManage || !provisioned || update.isLoading) return;
    void update
      .execute({ projectId, id: env.id, autoDeploy: !env.autoDeploy })
      .then((res) => {
        if (res.e) toast.error(t(res.e.message));
      });
  };
  return (
    <span
      role={canManage ? 'button' : undefined}
      title={!provisioned ? t(k.environments.autoDeployNeedsProvision) : t(k.environments.autoDeployHint)}
      onClick={toggle}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs',
        env.autoDeploy
          ? 'bg-violet-500/15 text-violet-700 dark:text-violet-400'
          : 'bg-muted/60 text-muted-foreground/70',
        canManage && provisioned && 'cursor-pointer hover:opacity-80',
        !provisioned && 'opacity-50',
      )}
    >
      <Rocket className="size-3" />
      {t(env.autoDeploy ? k.environments.autoDeploy : k.environments.autoDeployOff)}
    </span>
  );
}

function UserEnvEditor({
  env,
  projectId,
  canManage,
}: {
  env: Environment;
  projectId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const setVar = useSetEnvVar(projectId);
  const deleteVar = useDeleteEnvVar(projectId);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim().toUpperCase();
    if (!trimmed || !value) return;
    const res = await setVar.execute({ projectId, id: env.id, name: trimmed, value });
    if (res.e) {
      toast.error(t(res.e.message));
      return;
    }
    setName('');
    setValue('');
  };

  return (
    <div className="space-y-1.5">
      <p className="inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <KeyRound className="size-3" />
        {t(k.environments.userEnvTitle)}
      </p>
      <p className="text-xs text-muted-foreground/70">{t(k.environments.userEnvHint)}</p>

      {env.userEnvNames.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t(k.environments.userEnvEmpty)}</p>
      ) : (
        <div className="rounded-md border bg-card text-xs">
          {env.userEnvNames.map((varName) => (
            <div
              key={varName}
              className="flex items-center gap-2 border-b px-2 py-1 last:border-b-0"
            >
              <span className="font-mono">{varName}</span>
              <span className="text-muted-foreground/60">••••••••</span>
              {canManage && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`${t(k.environments.deleteVarConfirmTitle)} ${varName}`}
                  className="ml-auto size-6 text-muted-foreground"
                  onClick={() => setDeleting(varName)}
                >
                  <Trash2 className="size-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <form
          className="flex flex-wrap items-center gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(k.environments.varName)}
            className="h-8 w-40 font-mono text-xs uppercase"
          />
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t(k.environments.varValueWriteOnly)}
            autoComplete="new-password"
            className="h-8 flex-1 min-w-40 font-mono text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={setVar.isLoading}>
            {env.userEnvNames.includes(name.trim().toUpperCase())
              ? t(k.environments.replaceVar)
              : t(k.environments.setVar)}
          </Button>
        </form>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.environments.deleteVarConfirmTitle)}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting} — {t(k.environments.deleteVarConfirmBody)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteVar.isLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const varName = deleting;
                if (!varName) return;
                void deleteVar.execute({ projectId, id: env.id, name: varName }).then((res) => {
                  if (res.e) toast.error(t(res.e.message));
                  else setDeleting(null);
                });
              }}
            >
              {t(k.common.actions.delete)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddEnvironmentDialog({
  projectId,
  open,
  onOpenChange,
  taken,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: string[];
}) {
  const { t } = useTranslation();
  const create = useCreateEnvironment(projectId);
  const { data: serversData } = useServers();
  // Only app-role servers can host an environment; the API enforces the same.
  const appServers = (serversData?.data ?? []).filter((s) => s.roles.includes('app'));

  const freeNames = ENVIRONMENT_NAMES.filter((n) => !taken.includes(n));
  const [name, setName] = useState<EnvironmentName | ''>('');
  const [serverId, setServerId] = useState('');
  const [domain, setDomain] = useState('');
  const [deployPath, setDeployPath] = useState('');
  const [autoDeploy, setAutoDeploy] = useState(false);

  const submit = async () => {
    const pickedName = name || freeNames[0];
    const pickedServer = serverId || appServers[0]?.id;
    if (!pickedName || !pickedServer) return;
    const res = await create.execute({
      projectId,
      name: pickedName,
      serverId: pickedServer,
      domain: domain.trim() || undefined,
      deployPath: deployPath.trim() || undefined,
      autoDeploy,
    });
    if (res.e) {
      toast.error(t(res.e.message));
      return;
    }
    setName('');
    setServerId('');
    setDomain('');
    setDeployPath('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(k.environments.addEnvironment)}</DialogTitle>
          <DialogDescription>{t(k.environments.description)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="env-name">{t(k.environments.name)}</Label>
              <NativeSelect
                id="env-name"
                value={name || freeNames[0] || ''}
                onChange={(e) => setName(e.target.value as EnvironmentName)}
              >
                {freeNames.map((n) => (
                  <NativeSelectOption key={n} value={n}>
                    {n}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="env-server">{t(k.environments.server)}</Label>
              <NativeSelect
                id="env-server"
                value={serverId || appServers[0]?.id || ''}
                onChange={(e) => setServerId(e.target.value)}
              >
                {appServers.map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {s.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">{t(k.environments.serverHint)}</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="env-domain">{t(k.environments.domain)}</Label>
            <Input
              id="env-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="staging.example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="env-path">{t(k.environments.deployPath)}</Label>
            <Input
              id="env-path"
              value={deployPath}
              onChange={(e) => setDeployPath(e.target.value)}
              placeholder="/srv/myapp"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t(k.environments.deployPathHint)}</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="env-autodeploy">{t(k.environments.autoDeploy)}</Label>
              <p className="text-xs text-muted-foreground">{t(k.environments.autoDeployHint)}</p>
            </div>
            <Switch id="env-autodeploy" checked={autoDeploy} onCheckedChange={setAutoDeploy} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(k.common.actions.cancel)}
            </Button>
            <Button
              type="submit"
              disabled={create.isLoading || freeNames.length === 0 || appServers.length === 0}
            >
              {t(k.environments.addEnvironment)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
