import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ArchiveRestore, FolderKanban, GitBranch, Plus, Settings2 } from 'lucide-react';
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
import { PageHeader } from '@/shared/components/page-header';
import { useCan } from '@/shared/hooks/use-permissions';
import { StatusStrip } from './components/status-strip';
import { useArchiveProject, useProjects, useUnarchiveProject } from './hooks/use-projects';

function ProjectCard({
  project,
  canArchive,
  onArchive,
}: {
  project: Project;
  canArchive: boolean;
  onArchive: (project: Project) => void;
}) {
  const { t } = useTranslation();

  return (
    <Link to={`/projects/${project.id}`}>
      <Card className="group h-full py-0 transition-colors hover:bg-muted/40">
        <CardContent className="flex h-full flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{project.name}</p>
            {canArchive && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t(k.tasks.archiveProject)}
                    className="size-6 -my-0.5 -mr-1 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    onClick={(e) => e.preventDefault()}
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.preventDefault()}>
                  <DropdownMenuItem variant="destructive" onSelect={() => onArchive(project)}>
                    {t(k.tasks.archiveProject)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {project.context && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{project.context}</p>
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
  const { data, isLoading } = useProjects();
  const archived = useProjects(true);
  const canArchive = useCan('project:delete');
  const archive = useArchiveProject();
  const unarchive = useUnarchiveProject();
  const [confirming, setConfirming] = useState<Project | null>(null);

  const projects = data?.data ?? [];
  const archivedProjects = archived.data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FolderKanban}
        title={t(k.tasks.projects)}
        description={t(k.tasks.projectsDescription)}
        actions={
          <Button onClick={() => navigate('/projects/create')}>
            <Plus className="size-4 mr-1" />
            {t(k.tasks.newProject)}
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          <Button onClick={() => navigate('/projects/create')}>
            <Plus className="size-4 mr-1" />
            {t(k.tasks.newProject)}
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              canArchive={canArchive}
              onArchive={setConfirming}
            />
          ))}
        </div>
      )}

      {archivedProjects.length > 0 && (
        <section className="space-y-3 border-t pt-5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(k.tasks.archivedProjects)}
          </h3>
          <ul className="space-y-1.5">
            {archivedProjects.map((project) => (
              <li
                key={project.id}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/40"
              >
                <span className="truncate">{project.name}</span>
                {canArchive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs"
                    disabled={unarchive.isLoading}
                    onClick={() => void unarchive.execute({ id: project.id })}
                  >
                    <ArchiveRestore className="size-3.5" />
                    {t(k.tasks.unarchiveProject)}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {unarchive.error && (
            <p className="text-xs text-destructive">{t(unarchive.error.message)}</p>
          )}
        </section>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.tasks.archiveConfirmTitle)}</AlertDialogTitle>
            <AlertDialogDescription>{t(k.tasks.archiveConfirmBody)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isLoading}
              onClick={async () => {
                if (!confirming) return;
                const res = await archive.execute({ id: confirming.id });
                if (!res.e) setConfirming(null);
              }}
            >
              {t(k.tasks.archiveProject)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
