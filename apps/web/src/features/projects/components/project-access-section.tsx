import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronRight, GitBranch, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCan } from '@/shared/hooks/use-permissions';
import {
  useGrantProjectAccess,
  useOrgMembers,
  useProjectMembers,
  useRevokeProjectAccess,
} from '../hooks/use-projects';

/**
 * The per-project visibility ACL surface (owners/admins only): who among the
 * org's members may SEE this project. Deny-by-default — a member appears here
 * only once granted. Owners and admins always see every project, so they are
 * not listed as grantable.
 *
 * For a repo-bound project this also REFLECTS the GitHub-collaborator reminder:
 * specbook controls visibility here, never the repository seat — that stays a
 * GitHub action the owner performs.
 */
export function ProjectAccessSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const canManage = useCan('project:grant-access');
  const { data } = useProjectMembers(canManage ? projectId : null);
  const { data: orgMembersData } = useOrgMembers();
  const grant = useGrantProjectAccess();
  const revoke = useRevokeProjectAccess();

  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Only owners/admins manage access; everyone else never sees this surface.
  if (!canManage) return null;

  const members = data?.data ?? [];
  const grantedIds = new Set(members.map((m) => m.userId));
  // Candidates to grant: org MEMBERs not already granted. Owners/admins are
  // omitted — they see every project by role, so a grant would be a no-op.
  const candidates = (orgMembersData?.data ?? []).filter(
    (u) => u.role === 'MEMBER' && !grantedIds.has(u.id),
  );

  const doGrant = (userId: string) => {
    setPickerOpen(false);
    void grant.execute({ id: projectId, userId }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });
  };
  const doRevoke = (userId: string) => {
    void revoke.execute({ id: projectId, userId }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });
  };

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
        <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t(k.tasks.access.title)}
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
            {members.length
              ? members.map((m) => m.name).join(' · ')
              : t(k.tasks.access.noMembers)}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <p className="text-xs text-muted-foreground/80">{t(k.tasks.access.description)}</p>

          {/* Repo-bound reminder: reflect the GitHub-collaborator need, never grant it. */}
          {data?.githubReminder && (
            <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              <GitBranch className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {t(k.tasks.access.githubReminder, { repo: data.githubReminder.repoFullName })}
              </span>
            </p>
          )}

          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(k.tasks.access.noMembers)}</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                  </div>
                  {m.orgRole === 'MEMBER' ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t(k.tasks.access.revoke)}
                      className="size-7 text-muted-foreground"
                      disabled={revoke.isLoading}
                      onClick={() => doRevoke(m.userId)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : (
                    // Owners/admins can't be revoked — they see all projects by role.
                    <Badge variant="secondary">{t(k.tasks.access.allProjects)}</Badge>
                  )}
                </div>
              ))}
            </div>
          )}

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" disabled={grant.isLoading}>
                <Plus className="mr-1 size-4" />
                {t(k.tasks.access.addMember)}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                {t(k.tasks.access.grantPlaceholder)}
              </p>
              {candidates.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t(k.tasks.access.nobodyToAdd)}
                </p>
              ) : (
                <div className="grid max-h-64 gap-0.5 overflow-y-auto">
                  {candidates.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => doGrant(u.id)}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                    >
                      <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{u.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {u.email}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
