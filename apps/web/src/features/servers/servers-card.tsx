import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Copy, HardDrive, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  SERVER_ROLES,
  type Server,
  type ServerRole,
  type UpdateServerRequest,
} from '@pkg/contracts';
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
import {
  useCreateServer,
  useRemoveServer,
  useServers,
  useTestServer,
  useUpdateServer,
} from '@/shared/servers/hooks';

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

type ServerForm = {
  name: string;
  host: string;
  port: string;
  sshUser: string;
  roles: ServerRole[];
};

const toForm = (s: Server): ServerForm => ({
  name: s.name,
  host: s.host,
  port: String(s.port),
  sshUser: s.sshUser,
  roles: s.roles ?? [],
});

const sameRoles = (a: readonly ServerRole[], b: readonly ServerRole[]): boolean =>
  a.length === b.length && a.every((r) => b.includes(r));

/**
 * Only the fields that actually changed go on the wire. The backend resets the
 * pinned host fingerprint whenever `host` or `port` is PRESENT in the patch, so
 * sending an unchanged host would silently re-verify a working server.
 */
export function serverPatch(original: Server, form: ServerForm): Omit<UpdateServerRequest, 'id'> {
  const patch: Omit<UpdateServerRequest, 'id'> = {};
  const name = form.name.trim();
  const host = form.host.trim();
  const port = Math.max(1, Math.min(65535, Number(form.port) || original.port));
  const sshUser = form.sshUser.trim();
  if (name && name !== original.name) patch.name = name;
  if (host && host !== original.host) patch.host = host;
  if (port !== original.port) patch.port = port;
  if (sshUser && sshUser !== original.sshUser) patch.sshUser = sshUser;
  if (!sameRoles(form.roles, original.roles ?? [])) patch.roles = form.roles;
  return patch;
}

/** True when the pending patch would clear the pinned fingerprint. */
export const resetsPin = (patch: Omit<UpdateServerRequest, 'id'>): boolean =>
  patch.host !== undefined || patch.port !== undefined;

export function ServersCard() {
  const { t } = useTranslation();
  const { data } = useServers();
  const canManage = useCan('settings:update');
  const create = useCreateServer();
  const remove = useRemoveServer();
  const test = useTestServer();
  const update = useUpdateServer();

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', port: '22', sshUser: 'deploy' });
  const [roles, setRoles] = useState<ServerRole[]>(['app']);
  /** Set right after creation: the one moment the key ceremony happens. */
  const [revealed, setRevealed] = useState<Server | null>(null);
  const [removing, setRemoving] = useState<Server | null>(null);
  /** The server being edited and its live form; null when the dialog is closed. */
  const [editing, setEditing] = useState<{ server: Server; form: ServerForm } | null>(null);
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

  const editPatch = editing ? serverPatch(editing.server, editing.form) : {};
  const editHasChanges = Object.keys(editPatch).length > 0;
  const editRolesMissing = editing !== null && editing.form.roles.length === 0;
  const editNameTaken = update.error?.message === k.servers.errors.nameTaken;

  const openEdit = (s: Server) => {
    update.reset();
    setEditing({ server: s, form: toForm(s) });
  };
  const setEditForm = (next: Partial<ServerForm>) =>
    setEditing((prev) => (prev ? { ...prev, form: { ...prev.form, ...next } } : prev));

  const saveEdit = async () => {
    if (!editing || !editHasChanges || editRolesMissing) return;
    const res = await update.execute({ id: editing.server.id, ...editPatch });
    if (res.e) return;
    setEditing(null);
    toast.success(t(k.servers.saved));
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
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        statusStyles[s.status],
                      )}
                    >
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
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground"
                      aria-label={t(k.servers.edit)}
                      onClick={() => openEdit(s)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
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
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="grid gap-1.5">
                <Label>{t(k.servers.host)}</Label>
                <Input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t(k.servers.port)}</Label>
                <Input
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t(k.servers.sshUser)}</Label>
              <Input
                value={form.sshUser}
                onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
              />
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
              disabled={
                !form.name.trim() || !form.host.trim() || roles.length === 0 || create.isLoading
              }
              onClick={() => void submit()}
            >
              {create.isLoading && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t(k.servers.add)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog — PATCH /servers/:id with only the changed fields */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(k.servers.editTitle)}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {editing?.server.sshUser}@{editing?.server.host}:{editing?.server.port}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-server-name">{t(k.servers.name)}</Label>
                <Input
                  id="edit-server-name"
                  value={editing.form.name}
                  aria-invalid={editNameTaken || undefined}
                  onChange={(e) => {
                    update.reset();
                    setEditForm({ name: e.target.value });
                  }}
                />
                {editNameTaken && (
                  <p className="text-xs text-destructive">{t(k.servers.errors.nameTaken)}</p>
                )}
              </div>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-server-host">{t(k.servers.host)}</Label>
                  <Input
                    id="edit-server-host"
                    value={editing.form.host}
                    onChange={(e) => setEditForm({ host: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="edit-server-port">{t(k.servers.port)}</Label>
                  <Input
                    id="edit-server-port"
                    value={editing.form.port}
                    onChange={(e) => setEditForm({ port: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-server-ssh-user">{t(k.servers.sshUser)}</Label>
                <Input
                  id="edit-server-ssh-user"
                  value={editing.form.sshUser}
                  onChange={(e) => setEditForm({ sshUser: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t(k.servers.roles)}</Label>
                <div className="flex gap-4">
                  {SERVER_ROLES.map((role) => (
                    <label key={role} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={editing.form.roles.includes(role)}
                        onCheckedChange={(v) =>
                          setEditForm({
                            roles: v
                              ? [...editing.form.roles, role]
                              : editing.form.roles.filter((r) => r !== role),
                          })
                        }
                      />
                      {t(k.servers.role[role])}
                    </label>
                  ))}
                </div>
                {editRolesMissing && (
                  <p className="text-xs text-destructive">{t(k.servers.rolesRequired)}</p>
                )}
              </div>
              {/* Shown BEFORE saving, the moment host or port differs: the reset is
                  existing backend behaviour and must not be a surprise. */}
              {resetsPin(editPatch) && (
                <p
                  role="alert"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
                >
                  {t(k.servers.pinResetWarning)}
                </p>
              )}
              {update.error && !editNameTaken && (
                <p className="text-xs text-destructive">{t(update.error.message)}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t(k.common.actions.cancel)}
            </Button>
            <Button
              disabled={!editHasChanges || editRolesMissing || update.isLoading}
              title={!editHasChanges ? t(k.servers.noChanges) : undefined}
              onClick={() => void saveEdit()}
            >
              {update.isLoading && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t(k.servers.save)}
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
                void (
                  removing &&
                  remove.execute({ id: removing.id }).then((r) => !r.e && setRemoving(null))
                )
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
