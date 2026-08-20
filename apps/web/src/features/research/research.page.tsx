import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { formatDistanceToNow } from 'date-fns';
import { ArrowLeft, ArrowRight, Search, SendHorizontal, Sparkles } from 'lucide-react';
import type { Research } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/shared/lib/utils';
import { initials, tintFor } from '@/shared/lib/avatar';
import { useCan } from '@/shared/hooks/use-permissions';
import { ResearchStatusPill } from './components/research-status-pill';
import { useCreateResearch, useRecentResearch, useResearchSearch } from './hooks/use-research';

function titleFromMessage(text: string): string {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
  return (firstLine || text.trim()).slice(0, 200);
}

function ResearchRow({ research, onOpen }: { research: Research; onOpen: () => void }) {
  const { t } = useTranslation();
  const time = formatDistanceToNow(new Date(research.updatedAt), { addSuffix: true });
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-background p-3 text-left transition-colors hover:bg-muted/40"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Search className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{research.title}</p>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {research.createdByName ? (
            <span className="flex min-w-0 items-center gap-1">
              <Avatar
                className={cn(
                  'size-4 shrink-0 rounded-full text-[9px] font-semibold',
                  tintFor(research.createdBy),
                )}
              >
                <AvatarFallback className={cn('rounded-full', tintFor(research.createdBy))}>
                  {initials(research.createdByName, research.createdByEmail ?? '')}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">
                {t(k.research.recent.by, { name: research.createdByName })}
              </span>
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
            </span>
          ) : null}
          <span className="shrink-0 truncate">{t(k.research.recent.updated, { time })}</span>
        </div>
      </div>
      <ResearchStatusPill status={research.status} />
    </button>
  );
}

/** The "Search all research" pane — an infinite keyset scroll over the feed. */
function SearchPane({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const { items, hasMore, isLoadingInitial, isLoadingMore, loadMore } = useResearchSearch(q);
  const sentinel = useRef<HTMLDivElement>(null);

  // Fetch the next keyset page as the sentinel scrolls into view; the "Load
  // more" button below is the same call, kept for keyboard reach.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isLoadingMore) loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, isLoadingMore, loadMore, items.length]);

  return (
    <div className="mx-auto w-full max-w-[42rem]">
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t(k.research.search.back)}
        </button>
      </div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t(k.research.search.placeholder)}
          aria-label={t(k.research.search.placeholder)}
          className="pl-9"
          autoFocus
        />
      </div>

      {isLoadingInitial ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t(k.research.search.noResults)}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <ResearchRow key={r.id} research={r} onOpen={() => onOpen(r.id)} />
          ))}
          <div ref={sentinel} />
          {hasMore ? (
            <Button variant="ghost" size="sm" className="w-full" onClick={loadMore} disabled={isLoadingMore}>
              {t(k.research.search.loadingMore)}
            </Button>
          ) : (
            <p className="py-3 text-center text-xs text-muted-foreground">
              {t(k.research.search.end)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ResearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canCreate = useCan('research:create');
  const canRead = useCan('research:read');
  const create = useCreateResearch();
  const recent = useRecentResearch();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'home' | 'search'>('home');

  const open = (id: string) => navigate(`/research/${id}`);

  const start = async () => {
    const text = prompt.trim();
    if (!text || !canCreate || create.isLoading) return;
    const res = await create.execute({ title: titleFromMessage(text), message: text });
    if (!res.e && res.d) {
      setPrompt('');
      navigate(`/research/${res.d.id}`);
    }
  };

  if (mode === 'search') {
    return (
      <div className="py-4">
        <SearchPane onBack={() => setMode('home')} onOpen={open} />
      </div>
    );
  }

  const recentItems = recent.data?.data ?? [];

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center py-8">
      <div className="w-full max-w-[42rem]">
        <h1 className="mb-6 text-center text-3xl font-semibold tracking-tight text-balance">
          {t(k.research.launcher.heading)}
        </h1>

        {canCreate && (
          <>
            <div className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2.5 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <span className="flex size-8 shrink-0 items-center justify-center self-center rounded-full bg-muted text-muted-foreground">
                <Sparkles className="size-4" />
              </span>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void start();
                  }
                }}
                rows={1}
                placeholder={t(k.research.launcher.placeholder)}
                aria-label={t(k.research.launcher.heading)}
                className="max-h-32 min-h-0 resize-none border-0 bg-transparent p-1.5 text-base shadow-none focus-visible:ring-0"
              />
              <Button
                size="icon"
                className="size-9 shrink-0 rounded-xl"
                aria-label={t(k.research.launcher.start)}
                disabled={create.isLoading || prompt.trim() === ''}
                onClick={() => void start()}
              >
                <SendHorizontal className="size-4" />
              </Button>
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              {t(k.research.launcher.subhint)}
            </p>
          </>
        )}

        {canRead && (
          <div className="mt-10">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t(k.research.recent.title)}
              </span>
              <button
                type="button"
                onClick={() => setMode('search')}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {t(k.research.recent.searchAll)}
                <ArrowRight className="size-3.5" />
              </button>
            </div>

            {recent.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-xl" />
                ))}
              </div>
            ) : recentItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 py-10 text-center">
                <p className="text-sm font-medium">{t(k.research.recent.empty)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(k.research.recent.emptyHint)}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentItems.map((r) => (
                  <ResearchRow key={r.id} research={r} onOpen={() => open(r.id)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
