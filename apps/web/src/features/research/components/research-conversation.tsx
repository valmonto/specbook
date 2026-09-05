import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileCheck2, SendHorizontal } from 'lucide-react';
import type { GetResearchResponse, ResearchMessage } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

function Bubble({ message, showDocMarker }: { message: ResearchMessage; showDocMarker: boolean }) {
  const { t } = useTranslation();
  const isUser = message.authorType === 'user';
  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <div
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
          isUser ? 'bg-primary' : 'bg-gradient-to-br from-violet-500 to-primary',
        )}
      >
        {isUser ? t(k.research.message.you)[0] : t(k.research.message.agent)[0]}
      </div>
      <div className={cn('min-w-0 max-w-[85%]', isUser && 'flex flex-col items-end')}>
        <div className="mb-1 text-xs text-muted-foreground">
          {isUser ? t(k.research.message.you) : t(k.research.message.agent)}
        </div>
        <div
          className={cn(
            'text-sm leading-relaxed break-words whitespace-pre-wrap',
            isUser && 'rounded-xl bg-primary/10 px-3 py-2',
          )}
        >
          {message.body}
        </div>
        {showDocMarker && (
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <FileCheck2 className="size-3.5" />
            {t(k.research.message.updatedDocument)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The conversation half of the detail view: the message stream and the
 * composer. Each reply dispatches an agent turn; while one is in flight the
 * stream shows a compact "researching…" affordance — never the raw tool work.
 * The agent's turn carries only an "Updated the document" marker, tying the
 * reply to the new version.
 */
export function ResearchConversation({
  research,
  canReply,
  sending,
  onBack,
  onSend,
}: {
  research: GetResearchResponse;
  canReply: boolean;
  sending: boolean;
  onBack: () => void;
  onSend: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  const messages = research.messages;
  const working = sending || research.status === 'researching';
  const lastAgentId = [...messages].reverse().find((m) => m.authorType !== 'user')?.id;

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, working]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !canReply || sending) return;
    onSend(text);
    setDraft('');
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border/60">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label={t(k.research.detail.back)}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="min-w-0 truncate text-sm font-medium">{research.title}</span>
      </header>

      <div ref={streamRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-5">
          {messages.length === 0 && !working && (
            <div className="mx-auto max-w-sm py-12 text-center">
              <p className="mb-2 text-lg font-medium tracking-tight">
                {t(k.research.composer.startTitle)}
              </p>
              <p className="text-sm text-muted-foreground">{t(k.research.composer.startBody)}</p>
            </div>
          )}
          {messages.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              showDocMarker={
                m.id === lastAgentId &&
                research.bodyMarkdown !== null &&
                research.status !== 'researching'
              }
            />
          ))}
          {working && (
            <div className="flex items-center gap-3 text-sm text-violet-600 dark:text-violet-400">
              <span className="flex size-6 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-primary" />
              <span>{t(k.research.detail.researching)}</span>
              <span className="flex gap-1">
                <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
                <span className="size-1.5 animate-pulse rounded-full bg-violet-500 [animation-delay:150ms]" />
                <span className="size-1.5 animate-pulse rounded-full bg-violet-500 [animation-delay:300ms]" />
              </span>
            </div>
          )}
        </div>
      </div>

      {canReply && (
        <div className="border-t border-border/60 px-5 py-4">
          <div className="mx-auto w-full max-w-[42rem]">
            <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                placeholder={t(k.research.composer.placeholder)}
                aria-label={t(k.research.composer.placeholder)}
                className="max-h-32 min-h-0 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
              />
              <Button
                size="icon"
                className="size-8 shrink-0"
                aria-label={t(k.research.composer.send)}
                disabled={sending || draft.trim() === ''}
                onClick={submit}
              >
                <SendHorizontal className="size-4" />
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{t(k.research.composer.hint)}</p>
          </div>
        </div>
      )}
    </section>
  );
}
