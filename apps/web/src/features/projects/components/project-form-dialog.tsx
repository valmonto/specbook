import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderKanban } from 'lucide-react';
import type { Project } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { WideModal } from '@/components/overlays/wide-modal';
import { useCreateProject, useUpdateProject } from '../hooks/use-projects';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit mode. */
  project?: Project | null;
}

/**
 * One modal for create and edit — same fields, different verb. WideModal (not
 * raw Dialog): the context document can be long, and its pinned header/footer
 * keep Create reachable while the body scrolls.
 */
export function ProjectFormDialog({ open, onOpenChange, project }: Props) {
  const { t } = useTranslation();
  const create = useCreateProject();
  const update = useUpdateProject();
  const busy = create.isLoading || update.isLoading;

  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [workdir, setWorkdir] = useState('');
  const [context, setContext] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setRepoUrl(project?.repoUrl ?? '');
    setDefaultBranch(project?.defaultBranch ?? 'main');
    setWorkdir(project?.workdir ?? '');
    setContext(project?.context ?? '');
  }, [open, project]);

  const submit = async () => {
    const base = {
      name: name.trim(),
      repoUrl: repoUrl.trim() || undefined,
      defaultBranch: defaultBranch.trim() || undefined,
      workdir: workdir.trim() || undefined,
      context: context.trim() || undefined,
    };
    const res = project
      ? await update.execute({ id: project.id, ...base })
      : await create.execute(base);
    if (!res.e) onOpenChange(false);
  };

  return (
    <WideModal
      open={open}
      onOpenChange={onOpenChange}
      icon={<FolderKanban />}
      title={t(project ? k.tasks.editProject : k.tasks.newProject)}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t(k.common.actions.cancel)}
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {t(project ? k.common.actions.save : k.common.actions.create)}
          </Button>
        </>
      }
    >
      <div className="mx-auto grid max-w-2xl gap-4">
        <div className="grid gap-2">
          <Label htmlFor="project-name">{t(k.tasks.projectName)}</Label>
          <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="project-repo">{t(k.tasks.repoUrl)}</Label>
            <Input
              id="project-repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/…"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-branch">{t(k.tasks.defaultBranch)}</Label>
            <Input
              id="project-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project-workdir">{t(k.tasks.workdir)}</Label>
          <Input
            id="project-workdir"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="/opt/…"
          />
          <p className="text-xs text-muted-foreground">{t(k.tasks.workdirHint)}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project-context">{t(k.tasks.contextDoc)}</Label>
          <Textarea
            id="project-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="min-h-48 font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">{t(k.tasks.contextDocHint)}</p>
        </div>
      </div>
    </WideModal>
  );
}
