import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { AcceptanceCriterion, GetTaskByIdResponse } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateTask } from '../hooks/use-projects';

interface Props {
  task: GetTaskByIdResponse;
  onClose: () => void;
}

/**
 * Spec editing after creation — forgetting a criterion no longer means
 * re-creating the task. Done flags on existing criteria survive text edits;
 * multi-line pastes split into rows like the create form.
 */
export function TaskEditForm({ task, onClose }: Props) {
  const { t } = useTranslation();
  const update = useUpdateTask();

  const [title, setTitle] = useState(task.title);
  const [context, setContext] = useState(task.context ?? '');
  const [outOfScope, setOutOfScope] = useState(task.outOfScope ?? '');
  const [criteria, setCriteria] = useState<AcceptanceCriterion[]>(
    task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria : [{ text: '', done: false }],
  );
  const [priority, setPriority] = useState(String(task.priority));
  const [isHumanTask, setIsHumanTask] = useState(task.isHumanTask);

  const setCriterionText = (i: number, text: string) =>
    setCriteria((prev) => prev.map((c, idx) => (idx === i ? { ...c, text } : c)));
  const removeCriterion = (i: number) =>
    setCriteria((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const pasteCriteria = (i: number, e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n')) return;
    e.preventDefault();
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ text: line, done: false }));
    if (lines.length === 0) return;
    setCriteria((prev) => {
      const next = [...prev];
      const target = next[i];
      next.splice(i, 1, ...(target?.text.trim() ? [target, ...lines] : lines));
      return next;
    });
  };

  const save = async () => {
    const res = await update.execute({
      id: task.id,
      title: title.trim(),
      context: context.trim() || null,
      outOfScope: outOfScope.trim() || null,
      acceptanceCriteria: criteria
        .map((c) => ({ ...c, text: c.text.trim() }))
        .filter((c) => c.text.length > 0),
      priority: Number.parseInt(priority, 10) || 0,
      isHumanTask,
    });
    if (!res.e) onClose();
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="edit-title">{t(k.tasks.taskTitle)}</Label>
        <Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-context">{t(k.tasks.taskContext)}</Label>
        <Textarea
          id="edit-context"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          className="min-h-24"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-oos">{t(k.tasks.outOfScope)}</Label>
        <Textarea
          id="edit-oos"
          value={outOfScope}
          onChange={(e) => setOutOfScope(e.target.value)}
          rows={2}
        />
      </div>
      <div className="grid gap-2">
        <Label>{t(k.tasks.acceptanceCriteria)}</Label>
        {criteria.map((c, i) => (
          <div key={i} className="flex items-start gap-2">
            {/* A wrapping textarea, not an Input: long criteria must wrap on
                phone widths. The inline ref autosizes it to its content. */}
            <textarea
              rows={1}
              ref={(el) => {
                if (el) {
                  el.style.height = 'auto';
                  el.style.height = `${el.scrollHeight}px`;
                }
              }}
              value={c.text}
              onChange={(e) => setCriterionText(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              onPaste={(e) => pasteCriteria(i, e)}
              placeholder={t(k.tasks.criterionPlaceholder)}
              className={cn(
                'min-w-0 flex-1 resize-none overflow-hidden rounded-md border border-input bg-transparent px-3 py-1.5 text-sm break-words shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                c.done && 'text-muted-foreground line-through',
              )}
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
          onClick={() => setCriteria((prev) => [...prev, { text: '', done: false }])}
        >
          <Plus className="size-4 mr-1" />
          {t(k.tasks.addCriterion)}
        </Button>
      </div>
      <div className="grid w-32 gap-2">
        <Label htmlFor="edit-priority">{t(k.tasks.priority)}</Label>
        <Input
          id="edit-priority"
          type="number"
          min={0}
          max={1000}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={isHumanTask}
          onCheckedChange={(checked) => setIsHumanTask(checked === true)}
        />
        {t(k.tasks.humanTaskToggle)}
      </label>
      {update.error && <p className="text-sm text-destructive">{t(update.error.message)}</p>}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={update.isLoading || !title.trim()}>
          {t(k.common.actions.save)}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={update.isLoading}>
          {t(k.common.actions.cancel)}
        </Button>
      </div>
    </div>
  );
}
