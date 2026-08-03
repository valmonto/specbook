import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Copy, HardDrive, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { SERVER_ROLES, type Server, type ServerRole } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useCreateServer, useRemoveServer, useServers, useTestServer } from '@/shared/servers/hooks';

const statusStyles: Record<Server['status'], string> = {
  unverified: 'bg-muted text-muted-foreground',
  reachable: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  unreachable: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  fingerprint_mismatch: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

/** "2m ago"-class recency, coarse on purpose. */
const ago = (iso: string | null): string => {
  if (!iso) return '—';
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

export function ServersCard() {
  const { t } = useTranslation();
  const { data } = useServers();
  const canManage = useCan('settings:update');
  const create = useCreateServer();
  const remove = useRemoveServer();
  const test = useTestServer();

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', port: '22', sshUser: 'deploy' });
  const [roles, setRoles] = useState<ServerRole[]>(['app']);
  /** Set right after creation: the one moment the key ceremony happens. */
  const [revealed, setRevealed] = useState<Server | null>(null);
  const [removing, setRemoving] = useState<Server | null>(null);
  const [copied, setCopied] = useState(false);

  const servers = data?.data ?? [];

  const submit = async () => {
    const res = await create.execute({
      name: form.name.trim(),
      host: form.host.trim(),
      port: Math.max(1, Math.min(65535, Number(form.port) || 22)),
      sshUser: form.sshUser.trim() || 'deploy',
      roles,
    });
    if (res.e || !res.d) return;
    setAdding(false);
    setForm({ name: '', host: '', port: '22', sshUser: 'deploy' });
    setRoles(['app']);
    setRevealed(res.d);
  };

  const copyKey = async (key: string) => {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
            <HardDrive className="size-4 text-primary" />
          </div>
          {t(k.servers.title)}
        </CardTitle>
        <CardDescription>{t(k.servers.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {servers.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {t(k.servers.empty)}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {servers.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {s.name}
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', statusStyles[s.status])}>
                      {t(k.servers.status[s.status])}
                    </span>
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {s.sshUser}@{s.host}:{s.port}
                    <span className="ml-2">
                      {(s.roles ?? []).map((r) => t(k.servers.role[r])).join(' · ')}
                    </span>
                    <span className="ml-2" title={s.lastCheckedAt ?? undefined}>
                      {t(k.servers.lastChecked)}: {ago(s.lastCheckedAt)}
                    </span>
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      disabled={test.isLoading}
                      onClick={() =>
                        void test.execute({ id: s.id }).then((r) => {
                          if (!r.e) toast.success(t(k.servers.testQueued));
                        })
                      }
                    >
                      <RefreshCw className="size-3.5" />
                      {t(k.servers.test)}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      aria-label={t(k.servers.remove)}
                      onClick={() => setRemoving(s)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4 mr-1" />
            {t(k.servers.add)}
          </Button>
        )}
        {create.error && <p className="text-xs text-destructive">{t(create.error.message)}</p>}
      </CardContent>

      {/* Add dialog */}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(k.servers.add)}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>{t(k.servers.name)}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="grid gap-1.5">
                <Label>{t(k.servers.host)}</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>{t(k.servers.port)}</Label>
                <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t(k.servers.sshUser)}</Label>
              <Input value={form.sshUser} onChange={(e) => setForm({ ...form, sshUser: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t(k.servers.roles)}</Label>
              <div className="flex gap-4">
                {SERVER_ROLES.map((role) => (
                  <label key={role} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={roles.includes(role)}
                      onCheckedChange={(v) =>
                        setRoles((prev) => (v ? [...prev, role] : prev.filter((r) => r !== role)))
                      }
                    />
                    {t(k.servers.role[role])}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!form.name.trim() || !form.host.trim() || roles.length === 0 || create.isLoading}
              onClick={() => void submit()}
            >
              {create.isLoading && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t(k.servers.add)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time public key reveal */}
      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t(k.servers.publicKeyTitle)}</DialogTitle>
            <DialogDescription>{t(k.servers.publicKeyHint)}</DialogDescription>
          </DialogHeader>
          <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {revealed?.publicKey}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => revealed && void copyKey(revealed.publicKey)}>
              {copied ? <Check className="size-4 mr-1" /> : <Copy className="size-4 mr-1" />}
              {t(copied ? k.servers.copied : k.servers.copyKey)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirm */}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.servers.removeConfirmTitle)}</AlertDialogTitle>
            <AlertDialogDescription>{t(k.servers.removeConfirmBody)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isLoading}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() =>
                void (removing && remove.execute({ id: removing.id }).then((r) => !r.e && setRemoving(null)))
              }
            >
              {t(k.servers.remove)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
