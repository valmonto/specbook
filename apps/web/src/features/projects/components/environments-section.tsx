import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ChevronRight,
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
import {
  useCreateEnvironment,
  useDeleteEnvVar,
  useEnvironments,
  useProvisionEnvironment,
  useRemoveEnvironment,
  useSetEnvVar,
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
  const remove = useRemoveEnvironment(projectId);
  const provision = useProvisionEnvironment(projectId);

  const platformNames = Object.keys(env.platformEnv).sort();
  const runProvision = () =>
    void provision.execute({ projectId, id: env.id }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
          {env.domain && (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
              <Globe className="size-3" />
              <span className="truncate font-mono">{env.domain}</span>
            </span>
          )}
          {env.autoDeploy && (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
              <Rocket className="size-3" />
              {t(k.environments.autoDeploy)}
            </span>
          )}
          <span
            className={cn(
              'inline-flex items-center rounded-md px-2 py-0.5 text-xs',
              provisionStyles[env.provisionStatus],
            )}
          >
            {t(provisionLabels[env.provisionStatus])}
          </span>
        </button>
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
