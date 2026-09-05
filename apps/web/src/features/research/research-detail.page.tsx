import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { CutTicketsRequest, GetResearchResponse, ResearchMessage } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { useCan } from '@/shared/hooks/use-permissions';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ResearchConversation } from './components/research-conversation';
import { ResearchDocument } from './components/research-document';
import { CutTicketsSheet } from './components/cut-tickets-sheet';
import {
  useAcceptResearch,
  useAppendMessage,
  useCutTickets,
  useProjectOptions,
  useReopenResearch,
  useResearch,
  useUpdateResearch,
} from './hooks/use-research';

type Optimistic = { key: string; body: string };
let optSeq = 0;

/**
 * The research detail: the conversation and the living document. Side-by-side
 * when the viewport is wide; Conversation/Document tabs when narrow, so the
 * document is never unreachable.
 */
export default function ResearchDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { researchId } = useParams<{ researchId: string }>();
  const id = researchId ?? null;

  const { data, isLoading } = useResearch(id);
  const projects = useProjectOptions();
  const projectList = projects.data?.data ?? [];

  const canReply = useCan('research:update');
  const canUpdate = useCan('research:update');
  const canAccept = useCan('research:accept');
  const canCut = useCan('task:create');

  const append = useAppendMessage();
  const accept = useAcceptResearch();
  const reopen = useReopenResearch();
  const update = useUpdateResearch();
  const cut = useCutTickets();

  const [view, setView] = useState<'conversation' | 'document'>('conversation');
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);
  const [cutOpen, setCutOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  if (isLoading) {
    return (
      <div className="-m-6 grid h-[calc(100dvh-3.5rem)] grid-cols-1 lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
        <div className="space-y-4 border-r border-border/60 p-6">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-3/4" />
        </div>
        <div className="hidden p-6 lg:block">
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">{t(k.research.detail.notFound)}</p>;
  }

  const research = data;

  // Optimistic user turns render immediately; the domain revalidation that
  // follows the append resolves them into the server's message list.
  const displayMessages: ResearchMessage[] = [
    ...research.messages,
    ...optimistic.map<ResearchMessage>((o) => ({
      id: o.key,
      researchId: research.id,
      orgId: research.orgId,
      authorId: research.createdBy,
      authorType: 'user',
      body: o.body,
      createdAt: new Date().toISOString(),
    })),
  ];
  const conversationView: GetResearchResponse = { ...research, messages: displayMessages };

  const onSend = async (text: string) => {
    const entry = { key: `opt-${optSeq++}`, body: text };
    setOptimistic((prev) => [...prev, entry]);
    const res = await append.execute({ id: research.id, body: text });
    setOptimistic((prev) => prev.filter((o) => o.key !== entry.key));
    if (res.e) toast.error(t(res.e.message));
  };

  const onAccept = async () => {
    const res = await accept.execute({ id: research.id });
    if (!res.e) toast.success(t(k.research.toasts.accepted));
    else toast.error(t(res.e.message));
  };

  const onChangeProject = async (projectId: string | null) => {
    const res = await update.execute({ id: research.id, projectId });
    if (res.e) toast.error(t(res.e.message));
  };

  const onCut = async (dto: Omit<CutTicketsRequest, 'id'>): Promise<boolean> => {
    const res = await cut.execute({ id: research.id, ...dto });
    if (res.e) {
      toast.error(t(res.e.message));
      return false;
    }
    toast.success(t(k.research.toasts.ticketsCreated, { count: res.d?.taskIds.length ?? 0 }));
    return true;
  };

  const onReopenConfirm = async () => {
    const res = await reopen.execute({ id: research.id, comment: feedback.trim() });
    if (!res.e) {
      toast.success(t(k.research.toasts.reopened));
      setReopenOpen(false);
      setFeedback('');
    } else {
      toast.error(t(res.e.message));
    }
  };

  return (
    <div className="-m-6 flex h-[calc(100dvh-3.5rem)] flex-col">
      <Tabs
        value={view}
        onValueChange={(v) => setView(v as 'conversation' | 'document')}
        className="border-b border-border/60 px-3 py-2 lg:hidden"
      >
        <TabsList className="w-full">
          <TabsTrigger value="conversation" className="flex-1">
            {t(k.research.detail.conversationTab)}
          </TabsTrigger>
          <TabsTrigger value="document" className="flex-1">
            {t(k.research.detail.documentTab)}
            {research.bodyMarkdown !== null && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                {t(k.research.document.version, { version: research.version })}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
        <div className={view === 'document' ? 'hidden lg:flex lg:min-h-0' : 'flex min-h-0'}>
          <ResearchConversation
            research={conversationView}
            canReply={canReply}
            sending={append.isLoading}
            onBack={() => navigate('/research')}
            onSend={onSend}
          />
        </div>
        <div className={view === 'conversation' ? 'hidden lg:flex lg:min-h-0' : 'flex min-h-0'}>
          <ResearchDocument
            research={research}
            projects={projectList}
            canAccept={canAccept}
            canUpdate={canUpdate}
            canCut={canCut}
            busy={accept.isLoading || reopen.isLoading}
            onAccept={onAccept}
            onReopen={() => setReopenOpen(true)}
            onChangeProject={onChangeProject}
            onCreateTickets={() => setCutOpen(true)}
          />
        </div>
      </div>

      <CutTicketsSheet
        open={cutOpen}
        onOpenChange={setCutOpen}
        research={research}
        projects={projectList}
        submitting={cut.isLoading}
        onSubmit={onCut}
      />

      <AlertDialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(k.research.document.reopen)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(k.research.errors.reopenFeedbackRequired)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t(k.research.composer.placeholder)}
            aria-label={t(k.research.document.reopen)}
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              disabled={reopen.isLoading || feedback.trim() === ''}
              onClick={(e) => {
                e.preventDefault();
                void onReopenConfirm();
              }}
            >
              {t(k.research.document.reopen)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
