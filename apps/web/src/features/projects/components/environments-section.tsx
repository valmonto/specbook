import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ChevronRight,
  ClipboardPaste,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
} from 'lucide-react';
import {
  ENVIRONMENT_NAMES,
  classifyEnvVarName,
  parseDotenv,
  type DotenvParseError,
  type Environment,
  type EnvironmentName,
  type EnvVarClassification,
} from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
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
  useBulkSetEnvVars,
  useCreateEnvironment,
  useDeployEnvironment,
  useEnvironments,
  useProvisionEnvironment,
  useRemoveEnvironment,
  useRevealEnvVars,
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
            onClick={(e) => e.stopPropagation()}
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
                e.stopPropagation();
                if (!latest.log && !deployInFlight) return;
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
                e.stopPropagation();
                if (!latest.log) return;
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
            onClick={(e) => e.stopPropagation()}
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
            onClick={(e) => {
              e.stopPropagation();
              runDeploy();
            }}
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
            onClick={(e) => {
              e.stopPropagation();
              runProvision();
            }}
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
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingRemove(true);
            }}
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

/**
 * One editable var in the grid. `origName` is the name the row had on the
 * server (null for a brand-new row) — the save carries a secret's sealed
 * value over from it, so a rename never needs the value resurfaced. `value`
 * is the pending edit: null means "unchanged, carry it over".
 */
interface EditRow {
  key: string;
  name: string;
  classification: EnvVarClassification;
  origName: string | null;
  value: string | null;
  /** config only: whether the decoded value is on screen. */
  revealed: boolean;
}

let rowSeq = 0;
const nextRowKey = () => `row-${rowSeq++}`;

const rowsFromVars = (vars: Environment['userEnvVars']): EditRow[] =>
  vars.map((v) => ({
    key: nextRowKey(),
    name: v.name,
    classification: v.classification,
    origName: v.name,
    value: null,
    revealed: false,
  }));

const rowsFromEnv = (env: Environment): EditRow[] => rowsFromVars(env.userEnvVars);

/** Does the grid differ from what the server holds? Drives the Save/Discard row. */
const rowsDirty = (rows: EditRow[], env: Environment): boolean => {
  if (rows.length !== env.userEnvVars.length) return true;
  const byName = new Map(env.userEnvVars.map((v) => [v.name, v]));
  return rows.some((r) => {
    if (r.value !== null) return true;
    const server = byName.get(r.name);
    return !server || r.origName !== r.name || server.classification !== r.classification;
  });
};

const PARSE_REASON: Record<DotenvParseError['reason'], string> = {
  missingEquals: k.environments.parseMissingEquals,
  emptyKey: k.environments.parseEmptyKey,
  badName: k.environments.parseBadName,
  duplicate: k.environments.parseDuplicate,
};

/**
 * The user-var editor: an editable grid with per-row secret/config
 * classification, masked-until-revealed config values, a `.env` bulk paste,
 * and a single atomic Save (add/rename/delete/reclassify in one pass).
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
  const bulk = useBulkSetEnvVars(projectId);
  const reveal = useRevealEnvVars(projectId);
  const [rows, setRows] = useState<EditRow[]>(() => rowsFromEnv(env));
  /** Decoded config values, fetched on demand and cached until the next save. */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pasteOpen, setPasteOpen] = useState(false);

  const dirty = rowsDirty(rows, env);
  // Re-sync from the server only when the var-set identity changes AND the
  // grid is clean — never clobber an in-progress edit (the list polls).
  const baseline = env.userEnvVars.map((v) => `${v.name}:${v.classification}`).join('|');
  const baselineRef = useRef(baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (baselineRef.current === baseline) return;
    baselineRef.current = baseline;
    if (!dirtyRef.current) {
      setRows(rowsFromEnv(env));
      setRevealed({});
      setErrors({});
    }
    // env is read through the latest render's closure when baseline moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline]);

  const patch = (key: string, next: Partial<EditRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const addRow = () =>
    setRows((rs) => [
      ...rs,
      { key: nextRowKey(), name: '', classification: 'config', origName: null, value: '', revealed: true },
    ]);

  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const importEntries = (entries: { name: string; value: string }[]) => {
    setRows((rs) => {
      const next = [...rs];
      for (const entry of entries) {
        const idx = next.findIndex((r) => r.name === entry.name);
        if (idx >= 0) {
          next[idx] = { ...next[idx]!, value: entry.value, revealed: true };
        } else {
          next.push({
            key: nextRowKey(),
            name: entry.name,
            classification: classifyEnvVarName(entry.name),
            origName: null,
            value: entry.value,
            revealed: true,
          });
        }
      }
      return next;
    });
  };

  const toggleReveal = async (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    if (row.revealed) {
      patch(key, { revealed: false });
      return;
    }
    // Fetch the decoded config values once, then cache for the whole grid.
    if (!(row.name in revealed)) {
      const res = await reveal.execute({ projectId, id: env.id });
      if (res.e) {
        toast.error(t(res.e.message));
        return;
      }
      setRevealed(res.d?.data ?? {});
    }
    patch(key, { revealed: true });
  };

  const save = async () => {
    const nextErrors: Record<string, string> = {};
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    for (const r of rows) {
      if (!r.name) nextErrors[r.key] = k.environments.varNameRequired;
      else if (!/^[A-Z][A-Z0-9_]*$/.test(r.name)) nextErrors[r.key] = k.environments.varNameInvalid;
      else if ((counts.get(r.name) ?? 0) > 1) nextErrors[r.key] = k.environments.errors.duplicateVar;
      else if (r.origName === null && !r.value) nextErrors[r.key] = k.environments.varValueRequired;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    const vars = rows.map((r) => ({
      name: r.name,
      classification: r.classification,
      value: r.value && r.value.length > 0 ? r.value : null,
      from: r.origName,
    }));
    const res = await bulk.execute({ projectId, id: env.id, vars });
    if (res.e) {
      toast.error(t(res.e.message));
      return;
    }
    // Re-seed straight from the saved server shape: the just-added rows are
    // still "dirty" (origName null), so the sync effect would refuse to reset
    // them — and secret values must drop back to write-only after a save.
    if (res.d) {
      baselineRef.current = res.d.userEnvVars.map((v) => `${v.name}:${v.classification}`).join('|');
      setRows(rowsFromVars(res.d.userEnvVars));
    }
    setRevealed({});
    setErrors({});
  };

  const discard = () => {
    setRows(rowsFromEnv(env));
    setRevealed({});
    setErrors({});
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <p className="inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <KeyRound className="size-3" />
          {t(k.environments.userEnvTitle)}
        </p>
        {canManage && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => setPasteOpen(true)}
          >
            <ClipboardPaste className="size-3.5" />
            {t(k.environments.pasteEnv)}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground/70">{t(k.environments.userEnvHint)}</p>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t(k.environments.userEnvEmpty)}</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <VarRow
              key={row.key}
              row={row}
              canManage={canManage}
              revealedValue={revealed[row.name]}
              error={errors[row.key]}
              onName={(name) => patch(row.key, { name: name.toUpperCase() })}
              onClassification={(classification) => patch(row.key, { classification })}
              onValue={(value) => patch(row.key, { value })}
              onToggleReveal={() => void toggleReveal(row.key)}
              onRemove={() => removeRow(row.key)}
            />
          ))}
        </div>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="button" size="sm" variant="outline" className="gap-1" onClick={addRow}>
            <Plus className="size-3.5" />
            {t(k.environments.addVar)}
          </Button>
          {dirty && (
            <>
              <Button
                type="button"
                size="sm"
                className="gap-1"
                disabled={bulk.isLoading}
                onClick={() => void save()}
              >
                <Save className="size-3.5" />
                {t(k.environments.saveVars)}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={bulk.isLoading}
                onClick={discard}
              >
                {t(k.environments.discardVars)}
              </Button>
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {t(k.environments.unsavedVars)}
              </span>
            </>
          )}
        </div>
      )}

      <PasteEnvDialog open={pasteOpen} onOpenChange={setPasteOpen} onImport={importEntries} />
    </div>
  );
}

/** A single editable variable row: name · classification · value · delete. */
function VarRow({
  row,
  canManage,
  revealedValue,
  error,
  onName,
  onClassification,
  onValue,
  onToggleReveal,
  onRemove,
}: {
  row: EditRow;
  canManage: boolean;
  revealedValue: string | undefined;
  error: string | undefined;
  onName: (name: string) => void;
  onClassification: (c: EnvVarClassification) => void;
  onValue: (value: string) => void;
  onToggleReveal: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const isConfig = row.classification === 'config';
  // config: show the decoded value once revealed; secret: never show it back.
  const shownValue = row.value ?? (isConfig && row.revealed ? (revealedValue ?? '') : '');
  const carriedOver = row.value === null && row.origName !== null;
  const placeholder = carriedOver
    ? t(k.environments.valueUnchanged)
    : isConfig
      ? t(k.environments.varValue)
      : t(k.environments.varValueWriteOnly);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={row.name}
          onChange={(e) => onName(e.target.value)}
          disabled={!canManage}
          placeholder={t(k.environments.varName)}
          aria-label={t(k.environments.varName)}
          className="h-8 w-44 font-mono text-xs uppercase"
        />
        <NativeSelect
          value={row.classification}
          onChange={(e) => onClassification(e.target.value as EnvVarClassification)}
          disabled={!canManage}
          aria-label={t(k.environments.classification)}
          className="h-8 w-28 text-xs"
        >
          <NativeSelectOption value="secret">{t(k.environments.classSecret)}</NativeSelectOption>
          <NativeSelectOption value="config">{t(k.environments.classConfig)}</NativeSelectOption>
        </NativeSelect>
        <div className="relative flex min-w-40 flex-1 items-center">
          <Input
            type={isConfig && row.revealed ? 'text' : 'password'}
            value={shownValue}
            onChange={(e) => onValue(e.target.value)}
            disabled={!canManage}
            placeholder={placeholder}
            autoComplete="new-password"
            className="h-8 flex-1 pr-8 font-mono text-xs"
          />
          {isConfig && (
            <button
              type="button"
              onClick={onToggleReveal}
              aria-label={t(row.revealed ? k.environments.hideValue : k.environments.revealValue)}
              title={t(row.revealed ? k.environments.hideValue : k.environments.revealValue)}
              className="absolute right-1.5 text-muted-foreground hover:text-foreground"
            >
              {row.revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          )}
        </div>
        {canManage && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`${t(k.common.actions.delete)} ${row.name}`}
            className="size-7 text-muted-foreground"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      {error && <p className="pl-1 pt-0.5 text-xs text-rose-600 dark:text-rose-400">{t(error)}</p>}
    </div>
  );
}

/** Paste a `.env` blob; parse into rows (all-or-nothing) before merging in. */
function PasteEnvDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (entries: { name: string; value: string }[]) => void;
}) {
  const { t } = useTranslation();
  const [blob, setBlob] = useState('');
  const [parseErrors, setParseErrors] = useState<DotenvParseError[]>([]);

  const reset = () => {
    setBlob('');
    setParseErrors([]);
  };

  const apply = () => {
    const result = parseDotenv(blob);
    if (!result.ok) {
      setParseErrors(result.errors);
      return;
    }
    onImport(result.entries);
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(k.environments.pasteEnvTitle)}</DialogTitle>
          <DialogDescription>{t(k.environments.pasteEnvHint)}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={blob}
          onChange={(e) => {
            setBlob(e.target.value);
            if (parseErrors.length) setParseErrors([]);
          }}
          placeholder={'API_KEY=sk-123\n# a comment\nPUBLIC_URL="https://example.com"'}
          rows={8}
          className="font-mono text-xs"
        />
        {parseErrors.length > 0 && (
          <div className="space-y-0.5 rounded-md border border-rose-500/30 bg-rose-500/5 p-2">
            <p className="text-xs font-medium text-rose-700 dark:text-rose-400">
              {t(k.environments.pasteEnvErrors)}
            </p>
            {parseErrors.map((err) => (
              <p key={err.line} className="font-mono text-xs text-rose-700 dark:text-rose-400">
                {t(k.environments.parseErrorLine, { line: err.line, reason: t(PARSE_REASON[err.reason]) })}
              </p>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t(k.common.actions.cancel)}
          </Button>
          <Button type="button" disabled={!blob.trim()} onClick={apply}>
            {t(k.environments.pasteEnvApply)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
