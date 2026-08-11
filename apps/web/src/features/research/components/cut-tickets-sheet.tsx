import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, X } from 'lucide-react';
import type { CutTicketsRequest, GetResearchResponse, Project } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

type Proposal = { key: string; title: string; context: string; selected: boolean };

let seq = 0;
const blank = (): Proposal => ({ key: `p${seq++}`, title: '', context: '', selected: true });

/**
 * The create-tickets picker: editable, selectable proposals whose target
 * project defaults to the research's own. Filing produces DRAFT tasks via the
 * cut-tickets endpoint — the Ready boundary still applies, so nothing is queued
 * for an agent by this action.
 */
export function CutTicketsSheet({
  open,
  onOpenChange,
  research,
  projects,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  research: GetResearchResponse;
  projects: Project[];
  submitting: boolean;
  onSubmit: (dto: Omit<CutTicketsRequest, 'id'>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [proposals, setProposals] = useState<Proposal[]>([blank()]);
  const [target, setTarget] = useState<string>(research.projectId ?? '');

  const update = (key: string, patch: Partial<Proposal>) =>
    setProposals((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setProposals((rows) => rows.filter((r) => r.key !== key));

  const ready = useMemo(
    () => proposals.filter((p) => p.selected && p.title.trim() !== ''),
    [proposals],
  );
  const total = proposals.length;
  const canCreate = ready.length > 0 && target !== '' && !submitting;

  const submit = async () => {
    if (!canCreate) return;
    const ok = await onSubmit({
      targetProjectId: target,
      proposals: ready.map((p) => ({
        title: p.title.trim(),
        ...(p.context.trim() ? { context: p.context.trim() } : {}),
      })),
    });
    if (ok) {
      onOpenChange(false);
      setProposals([blank()]);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/60">
          <SheetTitle>{t(k.research.cut.title)}</SheetTitle>
          <SheetDescription>{t(k.research.cut.subtitle)}</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t(k.research.cut.targetProject)}
            </label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t(k.research.cut.noProject)} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            {proposals.map((p) => (
              <div
                key={p.key}
                className={cn(
                  'rounded-lg border border-border/60 p-2.5',
                  !p.selected && 'opacity-60',
                )}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={p.selected}
                    aria-label={t(k.research.cut.selectTickets)}
                    onClick={() => update(p.key, { selected: !p.selected })}
                    className={cn(
                      'mt-1 flex size-4 shrink-0 items-center justify-center rounded border',
                      p.selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input',
                    )}
                  >
                    {p.selected && <Check className="size-3" />}
                  </button>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Input
                      value={p.title}
                      onChange={(e) => update(p.key, { title: e.target.value })}
                      placeholder={t(k.research.cut.titlePlaceholder)}
                      aria-label={t(k.research.cut.titlePlaceholder)}
                      className="h-8"
                    />
                    <Textarea
                      value={p.context}
                      onChange={(e) => update(p.key, { context: e.target.value })}
                      placeholder={t(k.research.cut.contextPlaceholder)}
                      aria-label={t(k.research.cut.contextPlaceholder)}
                      rows={2}
                      className="min-h-0 resize-none text-sm"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t(k.research.cut.fromChip, { title: research.title })}
                    </p>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t(k.research.cut.remove)}
                    onClick={() => remove(p.key)}
                    disabled={proposals.length === 1}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-full" onClick={() => setProposals((r) => [...r, blank()])}>
              <Plus className="size-3.5" />
              {t(k.research.cut.add)}
            </Button>
          </div>
        </div>

        <SheetFooter className="flex-row items-center gap-3 border-t border-border/60">
          <span className="flex-1 text-xs text-muted-foreground">
            {t(k.research.cut.selected, { count: ready.length, total })}
          </span>
          <Button disabled={!canCreate} onClick={() => void submit()}>
            {ready.length > 0
              ? t(k.research.cut.create, { count: ready.length })
              : t(k.research.cut.selectTickets)}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
