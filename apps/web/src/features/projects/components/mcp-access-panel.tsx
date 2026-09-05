import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronRight, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  MCP_ACCESS_CONFIRMATION_REQUIRED,
  MCP_ACCESS_DEFAULT_MINUTES,
  MCP_ACCESS_MAX_MINUTES,
  MCP_ACCESS_MIN_MINUTES,
  type DataAccessAuditEntry,
  type Environment,
} from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAccessAudit, useGrantMcpAccess, useRevokeMcpAccess } from '../hooks/use-environments';

/** "12:34" / "1h 02m" — the live countdown of an open window. */
export const formatRemaining = (untilIso: string, now = Date.now()): string => {
  const secs = Math.max(0, Math.floor((new Date(untilIso).getTime() - now) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Re-renders once a second while a window is open, so the countdown is live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The header chip: present only while a window is open — a closed door is
 * the default and needs no badge. Amber on purpose: it is a live exception.
 */
export function McpAccessChip({ env }: { env: Environment }) {
  const { t } = useTranslation();
  const open = env.mcpAccess !== 'none' && !!env.mcpAccessUntil;
  const now = useNow(open);
  if (!open) return null;
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      title={t(k.environments.mcpAccess.openRead)}
      className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300"
    >
      <ShieldAlert className="size-3" />
      {t(k.environments.mcpAccess.openRead)} · {formatRemaining(env.mcpAccessUntil!, now)}
    </span>
  );
}

/**
 * The agent data-access panel inside an environment: current state, who
 * opened it, a live countdown, revoke-now, open-a-window (louder for
 * production), and the audit trail. Lapsing needs no action — the server
 * already reports a lapsed window as 'none'.
 */
export function McpAccessPanel({
  env,
  projectId,
  canManage,
}: {
  env: Environment;
  projectId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeMcpAccess(projectId);
  const [granting, setGranting] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const open = env.mcpAccess !== 'none' && !!env.mcpAccessUntil;
  const now = useNow(open);
  const { data: audit } = useAccessAudit(projectId, showAudit ? env.id : null);

  const runRevoke = () =>
    void revoke.execute({ projectId, id: env.id }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });

  return (
    <div className="space-y-1.5">
      <p className="inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {open ? (
          <ShieldAlert className="size-3 text-amber-600 dark:text-amber-400" />
        ) : (
          <ShieldOff className="size-3" />
        )}
        {t(k.environments.mcpAccess.title)}
      </p>
      <p className="text-xs text-muted-foreground/70">{t(k.environments.mcpAccess.hint)}</p>
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs',
          open ? 'border-amber-500/40 bg-amber-500/5' : 'bg-card',
        )}
        data-testid="mcp-access-state"
      >
        {open ? (
          <>
            <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300">
              <ShieldCheck className="size-3.5" />
              {t(k.environments.mcpAccess.openRead)}
            </span>
            <span className="font-mono tabular-nums" data-testid="mcp-access-countdown">
              {t(k.environments.mcpAccess.remaining, {
                remaining: formatRemaining(env.mcpAccessUntil!, now),
              })}
            </span>
            <span className="text-muted-foreground">
              {t(k.environments.mcpAccess.openUntil, {
                time: new Date(env.mcpAccessUntil!).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
              {env.mcpAccessByName &&
                ` · ${t(k.environments.mcpAccess.grantedBy, { name: env.mcpAccessByName })}`}
            </span>
            {env.mcpAccessReason && (
              <span className="text-muted-foreground italic">“{env.mcpAccessReason}”</span>
            )}
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 gap-1 px-2 text-xs"
                disabled={revoke.isLoading}
                onClick={runRevoke}
              >
                <ShieldOff className="size-3" />
                {t(k.environments.mcpAccess.revoke)}
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ShieldOff className="size-3.5" />
              {t(k.environments.mcpAccess.closed)}
            </span>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 gap-1 px-2 text-xs"
                onClick={() => setGranting(true)}
              >
                <ShieldCheck className="size-3" />
                {t(k.environments.mcpAccess.openAction)}
              </Button>
            )}
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowAudit((s) => !s)}
        aria-expanded={showAudit}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', showAudit && 'rotate-90')} />
        {t(showAudit ? k.environments.mcpAccess.auditHide : k.environments.mcpAccess.auditShow)}
      </button>
      {showAudit && <AuditList entries={audit?.data ?? []} />}

      <GrantAccessDialog
        env={env}
        projectId={projectId}
        open={granting}
        onOpenChange={setGranting}
      />
    </div>
  );
}

const outcomeStyles: Record<DataAccessAuditEntry['outcome'], string> = {
  allowed: 'text-emerald-700 dark:text-emerald-400',
  denied: 'text-rose-700 dark:text-rose-400',
  failed: 'text-amber-700 dark:text-amber-400',
};

function AuditList({ entries }: { entries: DataAccessAuditEntry[] }) {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t(k.environments.mcpAccess.auditEmpty)}</p>
    );
  }
  return (
    <div className="max-h-64 overflow-auto rounded-md border bg-card font-mono text-[11px]">
      {entries.map((entry) => (
        <div key={entry.id} className="flex gap-2 border-b px-2 py-1 last:border-b-0">
          <span className="shrink-0 text-muted-foreground">
            {new Date(entry.createdAt).toLocaleString()}
          </span>
          <span className="shrink-0">{entry.agentName ?? entry.userName ?? '—'}</span>
          <span className="shrink-0 text-muted-foreground">
            {entry.resource}:{entry.operation}
          </span>
          <span className={cn('shrink-0 font-medium', outcomeStyles[entry.outcome])}>
            {t(k.environments.mcpAccess.outcome[entry.outcome])}
          </span>
          <span className="min-w-0 truncate text-muted-foreground" title={entry.target ?? ''}>
            {entry.target}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Opening a window. Production is the louder door: a mandatory reason, the
 * environment name typed back, and a shorter ceiling — the shape of the form
 * IS the confirmation, so nobody opens production by muscle memory.
 */
export function GrantAccessDialog({
  env,
  projectId,
  open,
  onOpenChange,
}: {
  env: Environment;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const grant = useGrantMcpAccess(projectId);
  const max = MCP_ACCESS_MAX_MINUTES[env.name];
  const loud = MCP_ACCESS_CONFIRMATION_REQUIRED.includes(env.name);
  const [minutes, setMinutes] = useState(String(MCP_ACCESS_DEFAULT_MINUTES[env.name]));
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');

  const parsed = Number.parseInt(minutes, 10);
  const minutesOk = Number.isInteger(parsed) && parsed >= MCP_ACCESS_MIN_MINUTES && parsed <= max;
  const loudOk = !loud || (reason.trim().length > 0 && confirm.trim() === env.name);
  const canSubmit = minutesOk && loudOk && !grant.isLoading;

  const submit = async () => {
    if (!canSubmit) return;
    const res = await grant.execute({
      projectId,
      id: env.id,
      mode: 'read',
      minutes: parsed,
      reason: reason.trim() || undefined,
      confirm: loud ? confirm.trim() : undefined,
    });
    if (res.e) {
      toast.error(t(res.e.message));
      return;
    }
    setReason('');
    setConfirm('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(k.environments.mcpAccess.dialogTitle, { env: env.name })}</DialogTitle>
          <DialogDescription>{t(k.environments.mcpAccess.dialogHint)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {loud && (
            <p
              role="alert"
              className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-300"
            >
              {t(k.environments.mcpAccess.productionWarning, { max })}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-minutes">{t(k.environments.mcpAccess.minutes)}</Label>
            <Input
              id="mcp-minutes"
              type="number"
              inputMode="numeric"
              min={MCP_ACCESS_MIN_MINUTES}
              max={max}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(k.environments.mcpAccess.minutesMax, {
                min: MCP_ACCESS_MIN_MINUTES,
                max,
                env: env.name,
              })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-reason">{t(k.environments.mcpAccess.reason)}</Label>
            <Textarea
              id="mcp-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={loud}
            />
            <p className="text-xs text-muted-foreground">
              {t(k.environments.mcpAccess.reasonHint)}
            </p>
          </div>
          {loud && (
            <div className="space-y-1.5">
              <Label htmlFor="mcp-confirm">
                {t(k.environments.mcpAccess.confirmLabel, { env: env.name })}
              </Label>
              <Input
                id="mcp-confirm"
                autoComplete="off"
                placeholder={t(k.environments.mcpAccess.confirmPlaceholder, { env: env.name })}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t(k.common.actions.cancel)}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t(k.environments.mcpAccess.openAction)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
