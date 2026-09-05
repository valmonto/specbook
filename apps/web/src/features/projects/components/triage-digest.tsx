import { useMemo, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Eye,
  GitMerge,
  MessageCircleQuestion,
  RotateCcw,
  Sunrise,
  TriangleAlert,
} from 'lucide-react';
import type { Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { StatusBadge } from './status-badge';
import { triageTasks, triageTotal, type TriageBucket } from './triage';
import { useBlockedQuestions } from '../hooks/use-projects';

/** Compact "2h" / "3d" ago — magnitude, not clocks (same idiom as the dashboard). */
function ago(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Morning triage: a read-only, per-project roll-up of what an unattended
 * (overnight) run left in the human's court, so a nightly full-auto run is
 * triageable in one glance. It never mutates task state — it only regroups
 * the tasks the board already loaded, by status + assumption flag:
 *
 *   - waiting on you: assumed — shipped on a flagged assumption (held; #86)
 *   - blocked — with the latest clarification question inline
 *   - needs review
 *   - changes requested
 *   - merged — landed on main in the last 24h
 *
 * A flagged-and-held task lands in "assumed" (not the plain status bucket) so
 * the assumption is never lost among ordinary reviews.
 */
export function TriageDigest({
  tasks,
  onSelectTask,
}: {
  tasks: Task[];
  onSelectTask: (task: Task) => void;
}) {
  const { t } = useTranslation();

  const buckets = useMemo(() => triageTasks(tasks), [tasks]);

  // Latest clarification question per blocked task — reuses the dashboard hook.
  const blockedIds = useMemo(
    () => buckets.blocked.map((task) => task.id).sort(),
    [buckets.blocked],
  );
  const { data: questions } = useBlockedQuestions(blockedIds);

  // Nothing since last night → no panel; the board below tells the full story.
  if (triageTotal(buckets) === 0) return null;

  const summary = [
    {
      n: buckets.merged.length,
      label: t(k.tasks.triage.summaryMerged, { n: buckets.merged.length }),
      cls: 'text-emerald-600 dark:text-emerald-300',
    },
    {
      n: buckets.needsReview.length,
      label: t(k.tasks.triage.summaryReview, { n: buckets.needsReview.length }),
      cls: 'text-violet-700 dark:text-violet-300',
    },
    {
      n: buckets.blocked.length,
      label: t(k.tasks.triage.summaryBlocked, { n: buckets.blocked.length }),
      cls: 'text-amber-700 dark:text-amber-300',
    },
    {
      n: buckets.changesRequested.length,
      label: t(k.tasks.triage.summaryChanges, { n: buckets.changesRequested.length }),
      cls: 'text-rose-600 dark:text-rose-300',
    },
    {
      n: buckets.assumed.length,
      label: t(k.tasks.triage.summaryAssumed, { n: buckets.assumed.length }),
      cls: 'text-amber-700 dark:text-amber-300',
    },
  ].filter((s) => s.n > 0);

  const hintFor = (bucket: TriageBucket, task: Task): ReactNode => {
    if (bucket === 'blocked' && questions?.[task.id]) {
      return (
        <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
          <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{questions[task.id]}</span>
        </p>
      );
    }
    if (bucket === 'assumed' && task.assumptionFlag) {
      return (
        <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">
            <span className="font-medium">{t(k.tasks.assumption.what)}: </span>
            {task.assumptionFlag.what}
          </span>
        </p>
      );
    }
    return null;
  };

  const groups: {
    key: TriageBucket;
    icon: ComponentType<{ className?: string }>;
    label: string;
    caption?: string;
  }[] = [
    {
      key: 'assumed',
      icon: TriangleAlert,
      label: t(k.tasks.triage.assumed),
      caption: t(k.tasks.triage.assumedHint),
    },
    { key: 'blocked', icon: MessageCircleQuestion, label: t(k.tasks.triage.blocked) },
    { key: 'needsReview', icon: Eye, label: t(k.tasks.triage.needsReview) },
    { key: 'changesRequested', icon: RotateCcw, label: t(k.tasks.triage.changesRequested) },
    { key: 'merged', icon: GitMerge, label: t(k.tasks.triage.merged) },
  ];

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/30 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Sunrise className="size-4 text-amber-500" />
          {t(k.tasks.triage.title)}
        </span>
        <span className="text-xs text-muted-foreground">{t(k.tasks.triage.window24h)}</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
          {summary.map((s) => (
            <span key={s.label} className={cn('font-medium', s.cls)}>
              {s.label}
            </span>
          ))}
        </span>
      </div>

      <div className="divide-y">
        {groups.map(({ key, icon: Icon, label, caption }) => {
          const rows = buckets[key];
          if (rows.length === 0) return null;
          return (
            <div key={key}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 bg-muted/10 px-4 pt-2.5 pb-1">
                <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <Icon className="size-3.5" />
                  {label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
                {caption && (
                  <span className="text-xs text-muted-foreground normal-case">— {caption}</span>
                )}
              </div>
              <div className="divide-y">
                {rows.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask(task)}
                    className="flex w-full flex-col gap-1 px-4 py-2 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <StatusBadge status={task.status} />
                      <span className="truncate text-sm font-medium">{task.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                        {ago(task.statusChangedAt)}
                      </span>
                    </div>
                    {hintFor(key, task)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
