import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Archive,
  ArchiveRestore,
  FolderKanban,
  GitBranch,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import type { Project } from '@pkg/contracts';
import { k } from '@pkg/locales';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/shared/components/page-header';
import { useCan } from '@/shared/hooks/use-permissions';
import { StatusStrip } from './components/status-strip';
import {
  useArchiveProject,
  useDeleteProject,
  useProjects,
  useUnarchiveProject,
} from './hooks/use-projects';

type PendingAction = { kind: 'archive' | 'unarchive' | 'delete'; project: Project } | null;

function ProjectCard({
  project,
  archived,
  canManage,
  onAction,
}: {
  project: Project;
  archived: boolean;
  canManage: boolean;
  onAction: (action: NonNullable<PendingAction>) => void;
}) {
  const { t } = useTranslation();

  return (
    <Link to={`/projects/${project.id}`}>
      <Card
        className={
          'group h-full py-0 transition-colors hover:bg-muted/40' +
          (archived ? ' opacity-70 saturate-50' : '')
        }
      >
        <CardContent className="flex h-full flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 font-medium">
              {archived && <Archive className="size-3.5 text-muted-foreground" />}
              {project.name}
            </p>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t(archived ? k.tasks.unarchiveProject : k.tasks.archiveProject)}
                    className="size-6 -my-0.5 -mr-1 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                    onClick={(e) => e.preventDefault()}
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.preventDefault()}>
                  {archived ? (
                    <>
                      <DropdownMenuItem onSelect={() => onAction({ kind: 'unarchive', project })}>
                        <ArchiveRestore className="size-3.5" />
                        {t(k.tasks.unarchiveProject)}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => onAction({ kind: 'delete', project })}
                      >
                        <Trash2 className="size-3.5" />
                        {t(k.tasks.deleteProject)}
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onAction({ kind: 'archive', project })}
                    >
                      <Archive className="size-3.5" />
                      {t(k.tasks.archiveProject)}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {project.context && (
            <p className="line-clamp-2 break-words text-sm text-muted-foreground">
              {project.context}
            </p>
          )}
          {project.repoUrl && (
            <p className="mt-auto inline-flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">
                {project.repoUrl.replace(/^https?:\/\//, '')}
              </span>
            </p>
          )}
          <StatusStrip counts={project.statusCounts ?? {}} className="mt-1" />
        </CardContent>
      </Card>
    </Link>
  );
}

export default function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const live = useProjects();
  const archived = useProjects(true);
  const canManage = useCan('project:delete');
  const archive = useArchiveProject();
  const unarchive = useUnarchiveProject();
  const remove = useDeleteProject();
  // The active tab lives in the URL (?tab=archived) so reloads and shared
  // links land on the same view.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: 'live' | 'archived' = searchParams.get('tab') === 'archived' ? 'archived' : 'live';
  const setTab = (next: 'live' | 'archived') =>
    setSearchParams(next === 'archived' ? { tab: next } : {}, { replace: true });
  const [pending, setPending] = useState<PendingAction>(null);
  // The dialog keeps its last labels while fading out — without this the
  // CTA visibly morphs to the default action mid-close.
  const lastPending = useRef<NonNullable<PendingAction>['kind']>('archive');
  if (pending) lastPending.current = pending.kind;

  const projects = (tab === 'archived' ? archived.data?.data : live.data?.data) ?? [];
  const archivedCount = archived.data?.data.length ?? 0;
  const isLoading = tab === 'archived' ? archived.isLoading : live.isLoading;
  const viewingArchived = tab === 'archived';

  // Every action goes through the confirm dialog — including unarchive
  // (it re-opens the agent queue, which is worth a deliberate click).
  const confirmAction = async () => {
    if (!pending) return;
    const action =
      pending.kind === 'delete' ? remove : pending.kind === 'unarchive' ? unarchive : archive;
    const res = await action.execute({ id: pending.project.id });
    if (!res.e) setPending(null);
  };
  const confirmKeys = {
    archive: {
      title: k.tasks.archiveConfirmTitle,
      body: k.tasks.archiveConfirmBody,
      cta: k.tasks.archiveProject,
    },
    unarchive: {
      title: k.tasks.unarchiveConfirmTitle,
      body: k.tasks.unarchiveConfirmBody,
      cta: k.tasks.unarchiveProject,
    },
    delete: {
      title: k.tasks.deleteConfirmTitle,
      body: k.tasks.deleteConfirmBody,
      cta: k.tasks.deleteProject,
    },
  }[pending?.kind ?? lastPending.current];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FolderKanban}
        title={t(k.tasks.projects)}
        description={t(k.tasks.projectsDescription)}
        actions={
          <div className="flex items-center gap-3">
            {(archivedCount > 0 || viewingArchived) && (
              <Tabs value={tab} onValueChange={(v) => setTab(v as 'live' | 'archived')}>
                <TabsList>
                  <TabsTrigger value="live">{t(k.tasks.projects)}</TabsTrigger>
                  <TabsTrigger value="archived">
                    {t(k.tasks.archivedProjects)}
                    <span className="ml-1 text-xs text-muted-foreground">{archivedCount}</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            <Button onClick={() => navigate('/projects/create')}>
              <Plus className="size-4 mr-1" />
              {t(k.tasks.newProject)}
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{t(k.tasks.noProjects)}</EmptyTitle>
            <EmptyDescription>{t(k.tasks.noProjectsDesc)}</EmptyDescription>
          </EmptyHeader>
          {!viewingArchived && (
            <Button onClick={() => navigate('/projects/create')}>
              <Plus className="size-4 mr-1" />
              {t(k.tasks.newProject)}
            </Button>
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              archived={viewingArchived}
              canManage={canManage}
              onAction={(action) => {
                // Deferred past the dropdown's close: opening a dialog from a
                // closing menu otherwise loses the focus race and the dialog
                // dismisses itself immediately.
                setTimeout(() => setPending(action), 0);
              }}
            />
          ))}
        </div>
      )}
      {unarchive.error && <p className="text-xs text-destructive">{t(unarchive.error.message)}</p>}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(confirmKeys.title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(confirmKeys.body)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isLoading || remove.isLoading || unarchive.isLoading}
              className={
                pending?.kind === 'delete'
                  ? 'bg-destructive text-white hover:bg-destructive/90'
                  : undefined
              }
              onClick={() => void confirmAction()}
            >
              {t(confirmKeys.cta)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
