import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Plus, X } from 'lucide-react';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { WideModal } from '@/components/overlays/wide-modal';
import { useCreateTask } from '../hooks/use-projects';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

/**
 * Capture is frictionless by design: only the title is required to save a
 * draft. Context and criteria become mandatory at dispatch (draft → ready),
 * not here — strictness guards the agent queue, not the notepad.
 * WideModal so a long spec scrolls under a pinned Create button.
 */
export function TaskFormDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useTranslation();
  const create = useCreateTask();

  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [outOfScope, setOutOfScope] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  const [priority, setPriority] = useState('0');

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setContext('');
    setOutOfScope('');
    setCriteria(['']);
    setPriority('0');
  }, [open]);

  const submit = async () => {
    const res = await create.execute({
      projectId,
      title: title.trim(),
      context: context.trim() || undefined,
      outOfScope: outOfScope.trim() || undefined,
      acceptanceCriteria: criteria.map((c) => c.trim()).filter(Boolean),
      priority: Number.parseInt(priority, 10) || 0,
    });
    if (!res.e) onOpenChange(false);
  };

  const setCriterion = (i: number, value: string) =>
    setCriteria((prev) => prev.map((c, idx) => (idx === i ? value : c)));
  const removeCriterion = (i: number) =>
    setCriteria((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  return (
    <WideModal
      open={open}
      onOpenChange={onOpenChange}
      icon={<ListChecks />}
      title={t(k.tasks.newTask)}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isLoading}>
            {t(k.common.actions.cancel)}
          </Button>
          <Button onClick={submit} disabled={create.isLoading || !title.trim()}>
            {t(k.common.actions.create)}
          </Button>
        </>
      }
    >
      <div className="mx-auto grid max-w-2xl gap-4">
        <div className="grid gap-2">
          <Label htmlFor="task-title">{t(k.tasks.taskTitle)}</Label>
          <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="task-context">{t(k.tasks.taskContext)}</Label>
          <Textarea
            id="task-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="min-h-24"
          />
          <p className="text-xs text-muted-foreground">{t(k.tasks.taskContextHint)}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="task-oos">{t(k.tasks.outOfScope)}</Label>
          <Textarea
            id="task-oos"
            value={outOfScope}
            onChange={(e) => setOutOfScope(e.target.value)}
            rows={2}
          />
        </div>
        <div className="grid gap-2">
          <Label>{t(k.tasks.acceptanceCriteria)}</Label>
          {criteria.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={c}
                onChange={(e) => setCriterion(i, e.target.value)}
                placeholder={t(k.tasks.criterionPlaceholder)}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeCriterion(i)}
                disabled={criteria.length === 1}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => setCriteria((prev) => [...prev, ''])}
          >
            <Plus className="size-4 mr-1" />
            {t(k.tasks.addCriterion)}
          </Button>
        </div>
        <div className="grid w-32 gap-2">
          <Label htmlFor="task-priority">{t(k.tasks.priority)}</Label>
          <Input
            id="task-priority"
            type="number"
            min={0}
            max={1000}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </div>
      </div>
    </WideModal>
  );
}
