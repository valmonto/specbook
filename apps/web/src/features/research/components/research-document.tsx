import { useTranslation } from 'react-i18next';
import { Check, FileText, RotateCcw, Ticket } from 'lucide-react';
import type { GetResearchResponse, Project } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ResearchStatusPill } from './research-status-pill';
import { Markdown } from './markdown';

const NO_PROJECT = 'none';

/**
 * The artifact panel: the living document plus the header that governs it —
 * version, the (changeable) associated-project chip that defaults the ticket
 * target, Accept, and Create tickets.
 */
export function ResearchDocument({
  research,
  projects,
  canAccept,
  canUpdate,
  canCut,
  onAccept,
  onReopen,
  onChangeProject,
  onCreateTickets,
  busy,
}: {
  research: GetResearchResponse;
  projects: Project[];
  canAccept: boolean;
  canUpdate: boolean;
  canCut: boolean;
  onAccept: () => void;
  onReopen: () => void;
  onChangeProject: (projectId: string | null) => void;
  onCreateTickets: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const hasDoc = research.bodyMarkdown !== null && research.bodyMarkdown.trim() !== '';
  const isAccepted = research.status === 'accepted';

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-muted/30">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
          {t(k.research.document.label)}
        </span>
        <span className="text-xs text-muted-foreground">
          {hasDoc
            ? t(k.research.document.version, { version: research.version })
            : t(k.research.document.notStarted)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {isAccepted
            ? canAccept && (
                <Button size="sm" variant="outline" onClick={onReopen} disabled={busy}>
                  <RotateCcw className="size-3.5" />
                  {t(k.research.document.reopen)}
                </Button>
              )
            : canAccept && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAccept}
                  disabled={busy || research.status !== 'needs_review'}
                >
                  <Check className="size-3.5" />
                  {t(k.research.document.accept)}
                </Button>
              )}
          {canCut && (
            <Button size="sm" onClick={onCreateTickets} disabled={!hasDoc}>
              <Ticket className="size-3.5" />
              {t(k.research.document.createTickets)}
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <ResearchStatusPill status={research.status} />
          <span className="text-muted-foreground">·</span>
          {canUpdate ? (
            <Select
              value={research.projectId ?? NO_PROJECT}
              onValueChange={(v) => onChangeProject(v === NO_PROJECT ? null : v)}
            >
              <SelectTrigger
                size="sm"
                className="h-7 w-auto gap-1.5 rounded-full"
                aria-label={t(k.research.document.changeProject)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>{t(k.research.document.noProject)}</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="inline-flex items-center rounded-full bg-background px-2.5 py-0.5 text-xs font-medium ring-1 ring-border/60">
              {projects.find((p) => p.id === research.projectId)?.name ??
                t(k.research.document.noProject)}
            </span>
          )}
        </div>

        {hasDoc ? (
          <article className="max-w-[62ch]">
            <Markdown>{research.bodyMarkdown!}</Markdown>
          </article>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
            <FileText className="size-7 opacity-60" />
            <p className="max-w-[15rem] text-sm">{t(k.research.document.empty)}</p>
          </div>
        )}
      </div>
    </section>
  );
}
