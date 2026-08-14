import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from 'lucide-react';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DependencyPicker } from '../dependency-editor';

/**
 * "New task" as a split control: the primary button keeps the instant
 * capture-as-draft flow (creation IS editing), while the caret opens a small
 * dialog to be born with a "depends on" edge — planning that wants order set up
 * front. Both land on the fresh task expanded with its title focused.
 *
 * The dialog reuses the same {@link DependencyPicker} (filter + typeahead from
 * 019fffb0) the detail editor uses, over the given non-terminal `candidates`.
 */
export function NewTaskMenu({
  candidates,
  disabled,
  onNewTask,
  onCreateWithDependency,
  createError,
}: {
  /** Non-terminal tasks in the project — the eligible prerequisites. */
  candidates: Task[];
  disabled?: boolean;
  /** Instant path: create a bare untitled draft and land on it. */
  onNewTask: () => void;
  /** Create a task carrying a "depends on" edge; resolves true on success. */
  onCreateWithDependency: (input: { title: string; dependsOn: string }) => Promise<boolean>;
  /** Translation key of the last create error, if any. */
  createError?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Task | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The picker portals its popup into the dialog content — a modal Dialog marks
  // everything outside its content inert, which would freeze a body-portalled
  // popup and make its options unclickable.
  const contentRef = useRef<HTMLDivElement>(null);

  const reset = () => {
    setTitle('');
    setSelected(null);
    setSubmitting(false);
  };

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    const ok = await onCreateWithDependency({ title: title.trim(), dependsOn: selected.id });
    setSubmitting(false);
    if (ok) {
      setOpen(false);
      reset();
    }
  };

  return (
    <>
      <ButtonGroup>
        <Button disabled={disabled} onClick={onNewTask}>
          <Plus className="size-4 mr-1" />
          {t(k.tasks.newTask)}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={disabled} aria-label={t(k.tasks.newTaskWith.menu)}>
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={candidates.length === 0} onClick={() => setOpen(true)}>
              {t(k.tasks.newTaskWith.menu)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent ref={contentRef}>
          <DialogHeader>
            <DialogTitle>{t(k.tasks.newTaskWith.title)}</DialogTitle>
            <DialogDescription>{t(k.tasks.newTaskWith.description)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-task-title">{t(k.tasks.newTaskWith.titleLabel)}</Label>
              <Input
                id="new-task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t(k.tasks.v2.untitled)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t(k.tasks.detail.dependencies)}</Label>
              <DependencyPicker
                candidates={candidates}
                value={selected}
                onValueChange={setSelected}
                disabled={submitting}
                container={contentRef}
              />
            </div>
            {createError && <p className="text-sm text-destructive">{t(createError)}</p>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              {t(k.common.actions.cancel)}
            </Button>
            <Button disabled={submitting || !selected} onClick={() => void submit()}>
              {t(k.tasks.newTaskWith.create)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
