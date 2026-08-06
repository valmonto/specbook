import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CircleAlert, Inbox, MessageCircleQuestion, Radio, RotateCcw } from 'lucide-react';
import type { Agent, Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/shared/components/page-header';
import { StatusBadge } from './components/status-badge';
import { CiStateDot, PrStateBadge } from './components/github-state-badges';
import { TaskDetailSheet } from './components/task-detail-sheet';
import {
  useAgents,
  useBlockedQuestions,
  useProjects,
  useTaskCount,
  useTasksByStatus,
  useTransitionTask,
} from './hooks/use-projects';

const agentDot: Record<Agent['status'], string> = {
  working: 'bg-emerald-500',
  idle: 'bg-sky-500',
  offline: 'bg-zinc-400',
  stopped: 'bg-zinc-400',
  starting: 'bg-sky-500',
  auth_needed: 'bg-amber-500',
  error: 'bg-rose-500',
};

/**
 * One agent, one pill: name, what it is doing RIGHT NOW, and when it was
 * last heard from — the fleet at a glance, per the legibility rule.
 */
function AgentPill({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const stateLabel =
    agent.status === 'working' && agent.currentTaskTitle
      ? t(k.agents.workingOn, { task: agent.currentTaskTitle })
      : t(k.agents.status[agent.status]);
  return (
    <div
      className="flex max-w-full items-center gap-2 rounded-lg border bg-card/50 px-3 py-1.5"
      title={stateLabel}
    >
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          agentDot[agent.status],
          agent.status === 'working' && 'animate-pulse',
        )}
      />
      <span className="shrink-0 text-sm font-medium">{agent.name}</span>
      <span className="truncate text-xs text-muted-foreground">{stateLabel}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {agent.lastSeenAt ? t(k.agents.seen, { when: ago(agent.lastSeenAt) }) : t(k.agents.neverSeen)}
      </span>
    </div>
  );
}

const STALE_CLAIM_MS = 4 * 60 * 60 * 1000;

/** Compact "2h" / "3d" ago — the dashboard cares about magnitude, not clocks. */
function ago(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The daily view is not a kanban of everything — it is the human's side of
 * the protocol, and every element must answer "what do I do next":
 * review/answer (your move), unstick (stale claims), feed the queue.
 * Deliberately no charts, totals or history: those report the past; this
 * page routes the present.
 */
export default function YourMovePage() {
  const { t } = useTranslation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data: projectsData } = useProjects();
  const { data: needsReview, isLoading: loadingReview } = useTasksByStatus('needs_review');
  const { data: approved } = useTasksByStatus('approved');
  const { data: blocked, isLoading: loadingBlocked } = useTasksByStatus('blocked');
  const { data: inProgress } = useTasksByStatus('in_progress');
  const { count: readyCount } = useTaskCount('ready');
  const { count: draftCount } = useTaskCount('draft');
  const transition = useTransitionTask();

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsData?.data ?? []) map.set(p.id, p.name);
    return (id: string) => map.get(id) ?? '';
  }, [projectsData]);

  const yourMove = useMemo(() => {
    // Approved = the merge queue: still your move until it lands on main.
    const rows = [
      ...(needsReview?.data ?? []),
      ...(approved?.data ?? []),
      ...(blocked?.data ?? []),
    ];
    // Oldest wait first: the task that has been in your court longest leads.
    return rows.sort(
      (a, b) =>
        new Date(a.statusChangedAt ?? a.updatedAt).getTime() -
        new Date(b.statusChangedAt ?? b.updatedAt).getTime(),
    );
  }, [needsReview, approved, blocked]);

  const blockedIds = useMemo(
    () => (blocked?.data ?? []).map((task) => task.id).sort(),
    [blocked],
  );
  const { data: questions } = useBlockedQuestions(blockedIds);

  const loading = loadingReview || loadingBlocked;
  const inFlight = inProgress?.data ?? [];
  const { data: agentsData } = useAgents();
  const agents = agentsData?.data ?? [];

  const Row = ({ task }: { task: Task }) => (
    <button
      type="button"
      onClick={() => setSelectedTaskId(task.id)}
      className="flex w-full flex-col gap-1 rounded-lg border bg-card p-3 text-left shadow-xs transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center gap-2">
        <StatusBadge status={task.status} />
        <PrStateBadge task={task} />
        <CiStateDot task={task} />
        <span className="truncate text-xs text-muted-foreground">
          {projectName(task.projectId)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {t(k.tasks.dashboard.waiting, { when: ago(task.statusChangedAt) })}
        </span>
      </div>
      <p className="text-sm font-medium break-words">{task.title}</p>
      {task.status === 'blocked' && questions?.[task.id] && (
        <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
          <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{questions[task.id]}</span>
        </p>
      )}
    </button>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Inbox}
        title={t(k.tasks.dashboard.title)}
        description={t(k.tasks.dashboard.description)}
      />

      {/* Your move — the reason this page exists */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : yourMove.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{t(k.tasks.dashboard.empty)}</EmptyTitle>
            <EmptyDescription>{t(k.tasks.dashboard.emptyDesc)}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-2">
          {yourMove.map((task) => (
            <Row key={task.id} task={task} />
          ))}
        </div>
      )}

      {/* In flight — reassurance, and the stale-claim escape hatch */}
      {inFlight.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Bot className="size-3.5" />
            {t(k.tasks.dashboard.inFlight)}
          </h2>
          {inFlight.map((task) => {
            const stale =
              task.claimedAt !== null &&
              Date.now() - new Date(task.claimedAt).getTime() > STALE_CLAIM_MS;
            return (
              <div
                key={task.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-2',
                  stale && 'border-amber-500/40',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTaskId(task.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="truncate text-sm">{task.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {projectName(task.projectId)}
                  </span>
                </button>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {t(k.tasks.detail.claimedAgo, { when: ago(task.claimedAt) })}
                </span>
                {stale && (
                  <>
                    <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                      <CircleAlert className="size-3.5" />
                      {t(k.tasks.dashboard.stale)}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={transition.isLoading}
                      onClick={() => void transition.execute({ id: task.id, to: 'ready' })}
                    >
                      <RotateCcw className="size-3.5 mr-1" />
                      {t(k.tasks.actions.resetClaim)}
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Agents — the fleet strip: who works this board, live */}
      {agents.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Radio className="size-3.5" />
            {t(k.agents.title)}
          </h2>
          <div className="flex flex-wrap gap-2">
            {agents.map((agent) => (
              <AgentPill key={agent.id} agent={agent} />
            ))}
          </div>
        </section>
      )}

      {/* Queue health — one line; its only insight is "feed me" */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="text-xs font-medium tracking-wide uppercase">
          {t(k.tasks.dashboard.queue)}
        </span>
        <span className="tabular-nums">
          {t(k.tasks.dashboard.readyForAgents, { n: readyCount })}
        </span>
        <span className="tabular-nums">
          {t(k.tasks.dashboard.draftsWaiting, { n: draftCount })}
        </span>
        {readyCount === 0 && (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
            <CircleAlert className="size-3.5" />
            {t(k.tasks.dashboard.agentsIdle)}
          </span>
        )}
      </section>

      <TaskDetailSheet
        taskId={selectedTaskId}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskId(null);
        }}
      />
    </div>
  );
}
