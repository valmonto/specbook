import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FolderKanban, Pencil, Plus } from 'lucide-react';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/shared/components/page-header';
import { ProjectFormDialog } from './components/project-form-dialog';
import { TaskBoard } from './components/task-board';
import { TaskDetailSheet } from './components/task-detail-sheet';
import { TaskFormDialog } from './components/task-form-dialog';
import { useProject, useProjectTasks } from './hooks/use-projects';

export default function ProjectDetailPage() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project, isLoading } = useProject(projectId ?? null);
  const { data: tasksData, isLoading: tasksLoading } = useProjectTasks(projectId ?? null);

  const [editOpen, setEditOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  if (isLoading || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/projects" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t(k.tasks.projects)}
        </Link>
      </div>

      <PageHeader
        icon={FolderKanban}
        title={project.name}
        description={project.repoUrl ?? undefined}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4 mr-1" />
              {t(k.common.actions.edit)}
            </Button>
            <Button onClick={() => setNewTaskOpen(true)}>
              <Plus className="size-4 mr-1" />
              {t(k.tasks.newTask)}
            </Button>
          </div>
        }
      />

      {tasksLoading ? (
        <div className="flex gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 w-72" />
          ))}
        </div>
      ) : (
        <TaskBoard tasks={tasksData?.data ?? []} onSelectTask={setSelectedTaskId} />
      )}

      <ProjectFormDialog open={editOpen} onOpenChange={setEditOpen} project={project} />
      <TaskFormDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} projectId={project.id} />
      <TaskDetailSheet
        taskId={selectedTaskId}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
      />
    </div>
  );
}
