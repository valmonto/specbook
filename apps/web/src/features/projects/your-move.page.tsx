import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bot,
  CircleAlert,
  Inbox,
  MessageCircleQuestion,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Square,
} from 'lucide-react';
import type { Agent, Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/shared/components/page-header';
import { useCan } from '@/shared/hooks/use-permissions';
import { useServers } from '@/shared/servers/hooks';
import { StatusBadge } from './components/status-badge';
import { CiStateDot, PrStateBadge } from './components/github-state-badges';
import { TaskDetailSheet } from './components/task-detail-sheet';
import {
  useAgents,
  useBlockedQuestions,
  useCreateManagedAgent,
  useProjects,
  useStartAgent,
  useStopAgent,
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
 * last heard from — the fleet at a glance, per the legibility rule. Managed
 * agents add lifecycle controls and an expandable log; the auth_needed state
 * names the exact human action (the one command specbook will never run).
 */
function AgentPill({ agent, canManage }: { agent: Agent; canManage: boolean }) {
  const { t } = useTranslation();
  const [showLog, setShowLog] = useState(false);
  const start = useStartAgent();
  const stop = useStopAgent();
  const managed = agent.kind === 'managed';
  const running = ['idle', 'working', 'starting'].includes(agent.status);
  const stateLabel =
    agent.status === 'working' && agent.currentTaskTitle
      ? t(k.agents.workingOn, { task: agent.currentTaskTitle })
      : t(k.agents.status[agent.status]);
  const act = (action: typeof start) => () =>
    void action.execute({ id: agent.id }).then((res) => {
      if (res.e) toast.error(t(res.e.message));
    });

  return (
    <div className="max-w-full rounded-lg border bg-card/50">
      <div className="flex items-center gap-2 px-3 py-1.5" title={stateLabel}>
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
          {agent.lastSeenAt
            ? t(k.agents.seen, { when: ago(agent.lastSeenAt) })
            : t(k.agents.neverSeen)}
        </span>
        {managed && agent.log && (
          <button
            type="button"
            onClick={() => setShowLog((s) => !s)}
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t(showLog ? k.agents.hideLog : k.agents.showLog)}
          </button>
        )}
        {managed && canManage && !running && (
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs" disabled={start.isLoading} onClick={act(start)}>
            <Play className="size-3" />
            {t(k.agents.start)}
          </Button>
        )}
        {managed && canManage && running && (
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-muted-foreground" disabled={stop.isLoading} onClick={act(stop)}>
            <Square className="size-3" />
            {t(k.agents.stop)}
          </Button>
        )}
      </div>
      {agent.status === 'auth_needed' && (
        <p className="border-t bg-amber-500/10 px-3 py-1.5 font-mono text-xs text-amber-800 dark:text-amber-300">
          {t(k.agents.authNeededHint)}
        </p>
      )}
      {showLog && (
        <pre className="max-h-48 overflow-auto border-t bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-300">
          {agent.log || t(k.agents.logEmpty)}
        </pre>
      )}
    </div>
  );
}

/** Create-managed dialog: pick a runner server, name it, confirm if busy. */
function AddManagedAgentDialog({
  open,
  onOpenChange,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const create = useCreateManagedAgent();
  const { data: serversData } = useServers();
  const runnerServers = (serversData?.data ?? []).filter((s) => s.roles.includes('runner'));
  const [name, setName] = useState('');
  const [serverId, setServerId] = useState('');
  const [confirmAdditional, setConfirmAdditional] = useState(false);

  const picked = serverId || runnerServers[0]?.id || '';
  const busy = agents.some((a) => a.kind === 'managed' && a.serverId === picked);

  const submit = async () => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed || !picked) return;
    const res = await create.execute({
      serverId: picked,
      name: trimmed,
      confirmAdditional: busy ? confirmAdditional : undefined,
    });
    if (res.e) {
      toast.error(t(res.e.message));
      return;
    }
    setName('');
    setConfirmAdditional(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(k.agents.addManaged)}</DialogTitle>
          <DialogDescription>{t(k.agents.addManagedDesc)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">{t(k.agents.name)}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="runner-2"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-server">{t(k.agents.server)}</Label>
            <NativeSelect
              id="agent-server"
              value={picked}
              onChange={(e) => setServerId(e.target.value)}
            >
              {runnerServers.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t(k.agents.serverHint)}</p>
          </div>
          {busy && (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {t(k.agents.serverBusyWarning)}
              </p>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={confirmAdditional}
                  onCheckedChange={(v) => setConfirmAdditional(v === true)}
                />
                {t(k.agents.confirmAdditional)}
              </label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(k.common.actions.cancel)}
            </Button>
            <Button
              type="submit"
              disabled={
                create.isLoading || runnerServers.length === 0 || (busy && !confirmAdditional)
              }
            >
              {t(k.agents.addManaged)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const canManageAgents = useCan('settings:update');
  const [addingAgent, setAddingAgent] = useState(false);

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
      {(agents.length > 0 || canManageAgents) && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Radio className="size-3.5" />
            {t(k.agents.title)}
            {canManageAgents && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 gap-1 px-2 text-xs normal-case"
                onClick={() => setAddingAgent(true)}
              >
                <Plus className="size-3" />
                {t(k.agents.addManaged)}
              </Button>
            )}
          </h2>
          <div className="flex flex-wrap gap-2">
            {agents.map((agent) => (
              <AgentPill key={agent.id} agent={agent} canManage={canManageAgents} />
            ))}
          </div>
          <AddManagedAgentDialog
            open={addingAgent}
            onOpenChange={setAddingAgent}
            agents={agents}
          />
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
