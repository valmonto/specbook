import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FolderKanban, GitBranch, Plus } from 'lucide-react';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/shared/components/page-header';
import { ProjectFormDialog } from './components/project-form-dialog';
import { StatusStrip } from './components/status-strip';
import { useProjects } from './hooks/use-projects';

export default function ProjectsPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);

  const projects = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FolderKanban}
        title={t(k.tasks.projects)}
        description={t(k.tasks.projectsDescription)}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
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
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4 mr-1" />
            {t(k.tasks.newProject)}
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`}>
              <Card className="h-full py-0 transition-colors hover:bg-muted/40">
                <CardContent className="flex h-full flex-col gap-2 p-4">
                  <p className="font-medium">{project.name}</p>
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
          ))}
        </div>
      )}

      <ProjectFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
