import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bot,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitMerge,
  Loader2,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  Plus,
  RotateCcw,
  Undo2,
  User,
  X,
} from 'lucide-react';
import type { AcceptanceCriterion, Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddComment,
  useCheckCriterion,
  useDeleteTask,
  useMergeTask,
  useTask,
  useTaskPr,
  useTransitionTask,
  useUpdateTask,
} from '../../hooks/use-projects';
import { AttachmentsSection } from '../attachments-section';
import { StatusBadge } from '../status-badge';

/**
 * The v2 task rows: an accordion where the EXPANDED ROW IS the task detail —
 * context, out-of-scope, criteria, PR, attachments, activity, all visible,
 * and the spec edits in place, Notion-style: click the title, the context or
 * a criterion and it becomes editable; blur saves, Escape reverts. There is
 * no detail sheet and no edit dialog on this page.
 */

export interface CardProps {
  task: Task;
  expanded: boolean;
  /** Just created via "+ New task": the row mounts with its title in edit mode. */
  freshlyCreated?: boolean;
  /** Expand/collapse this card (the page enforces one-at-a-time). */
  onToggle: (id: string) => void;
}

const isTerminal = (task: Task) => task.status === 'done' || task.status === 'cancelled';

/** "2h" / "3d" — magnitude, not clocks (same idiom as the dashboard). */
const ago = (iso: string | null): string => {
  if (!iso) return '';
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const prChipStyles: Record<NonNullable<Task['prState']>, string> = {
  open: 'text-emerald-600 dark:text-emerald-400',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-rose-600 dark:text-rose-400',
};

/** Linear-style compact PR marker: colored icon + number, words in the tooltip. */
function PrChip({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.prState) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-xs tabular-nums',
        prChipStyles[task.prState],
      )}
      title={t(k.tasks.prState[task.prState])}
    >
      <GitMerge className="size-3.5" />
      {task.prNumber ? `#${task.prNumber}` : ''}
    </span>
  );
}

const ciDotStyles: Record<NonNullable<Task['ciState']>, string> = {
  pending: 'bg-amber-400 animate-pulse',
  passing: 'bg-emerald-500',
  failing: 'bg-rose-500',
};

/** CI as a bare dot — the words live in the tooltip. */
function CiDot({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.ciState) return null;
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', ciDotStyles[task.ciState])}
      title={t(k.tasks.ciState[task.ciState])}
    />
  );
}

const SECTION_HEADING =
  'flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase';

/**
 * A list row, not a card: the page wraps rows in ONE bordered container with
 * hairline dividers. Collapsed, clicking the title toggles; expanded, the
 * title becomes click-to-rename (the chevron keeps toggling).
 */
function CardShell({
  task,
  expanded,
  freshlyCreated,
  onToggle,
  children,
  actions,
}: CardProps & { children?: React.ReactNode; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  // A fresh "Untitled" draft mounts straight into renaming.
  const [editingTitle, setEditingTitle] = useState(Boolean(freshlyCreated));
  const [titleDraft, setTitleDraft] = useState(freshlyCreated ? task.title : '');
  const editable = !isTerminal(task);
  const total = task.acceptanceCriteria.length;
  const ticked = task.acceptanceCriteria.filter((c) => c.done).length;

  const saveTitle = async () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!next || next === task.title) return;
    const res = await update.execute({ id: task.id, title: next });
    if (res.e) toast.error(t(res.e.message));
  };

  return (
    <div className={cn(expanded && 'bg-muted/20')}>
      <div className="group flex h-11 items-center gap-2.5 px-3 transition-colors hover:bg-muted/40">
        <button
          type="button"
          onClick={() => onToggle(task.id)}
          aria-expanded={expanded}
          aria-label={task.title}
          className="flex h-full shrink-0 items-center px-0.5"
        >
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground/60 transition-transform',
              expanded && 'rotate-90',
            )}
          />
        </button>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            className="min-w-0 flex-1 border-b border-primary/40 bg-transparent text-sm font-medium outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (expanded && editable) {
                setTitleDraft(task.title);
                setEditingTitle(true);
              } else {
                onToggle(task.id);
              }
            }}
            className={cn(
              'h-full min-w-0 flex-1 truncate text-left text-sm font-medium',
              expanded && editable && 'cursor-text',
            )}
          >
            {task.title}
          </button>
        )}
        <PrChip task={task} />
        <CiDot task={task} />
        {total > 0 && (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground tabular-nums sm:inline-flex">
            <ListChecks className="size-3.5" />
            {ticked}/{total}
          </span>
        )}
        {task.priority > 0 && (
          <span className="hidden w-7 text-right text-xs text-muted-foreground tabular-nums sm:inline">
            P{task.priority}
          </span>
        )}
        <span className="hidden w-7 text-right text-xs text-muted-foreground/70 tabular-nums md:inline">
          {ago(task.statusChangedAt ?? task.updatedAt)}
        </span>
        {actions}
      </div>
      {expanded && children}
    </div>
  );
}

/**
 * Notion-style text block: rendered prose that turns into a textarea on
 * click; blur saves (empty clears the field), Escape reverts. Hidden
 * entirely when empty and not editable.
 */
function InlineArea({
  task,
  field,
  labelKey,
  placeholderKey,
}: {
  task: Task;
  field: 'context' | 'outOfScope';
  labelKey: string;
  placeholderKey: string;
}) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const value = task[field];
  const editable = !isTerminal(task);
  if (!value && !editable) return null;

  const save = async () => {
    setEditing(false);
    const next = draft.trim() || null;
    if ((value ?? null) === next) return;
    const res = await update.execute({ id: task.id, [field]: next });
    if (res.e) toast.error(t(res.e.message));
  };

  return (
    <div className="grid gap-1">
      <h4 className={SECTION_HEADING}>{t(labelKey)}</h4>
      {editing ? (
        /* Seamless, Notion-style: same typography, padding and position as
           the rendered text — the only edit signal is a faint tint. Height
           follows content natively (field-sizing) with a rows fallback for
           engines without it. */
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
          rows={Math.min(24, Math.max(3, draft.split('\n').length))}
          className="-mx-1.5 w-[calc(100%+0.75rem)] resize-none rounded-md bg-muted/40 px-1.5 py-0.5 text-sm leading-relaxed whitespace-pre-wrap outline-none [field-sizing:content]"
        />
      ) : (
        <button
          type="button"
          disabled={!editable}
          onClick={() => {
            setDraft(value ?? '');
            setEditing(true);
          }}
          className={cn(
            '-mx-1.5 rounded-md px-1.5 py-0.5 text-left text-sm leading-relaxed whitespace-pre-wrap',
            editable && 'cursor-text hover:bg-muted/50',
          )}
        >
          {value ?? <span className="text-muted-foreground/60 italic">{t(placeholderKey)}</span>}
        </button>
      )}
    </div>
  );
}

/**
 * The checklist, live: checkboxes tick against the server, criterion text
 * edits in place, rows add/remove inline. Text edits save the whole array
 * (small by design), preserving done flags.
 */
function CriteriaEditor({ task }: { task: Task }) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  const checkCriterion = useCheckCriterion();
  const editable = !isTerminal(task);
  const [draft, setDraft] = useState<AcceptanceCriterion[]>(task.acceptanceCriteria);
  // Server truth wins whenever the task refreshes (post-save revalidation).
  useEffect(() => setDraft(task.acceptanceCriteria), [task.acceptanceCriteria]);

  if (task.acceptanceCriteria.length === 0 && !editable) return null;

  const persist = async (next: AcceptanceCriterion[]) => {
    const cleaned = next.filter((c) => c.text.trim());
    const res = await update.execute({ id: task.id, acceptanceCriteria: cleaned });
    if (res.e) toast.error(t(res.e.message));
  };

  const setText = (i: number, text: string) =>
    setDraft((prev) => prev.map((c, idx) => (idx === i ? { ...c, text } : c)));
  const remove = (i: number) => {
    const next = draft.filter((_, idx) => idx !== i);
    setDraft(next);
    void persist(next);
  };

  return (
    <div className="grid gap-1">
      <h4 className={SECTION_HEADING}>
        {t(k.tasks.acceptanceCriteria)} ({draft.filter((c) => c.done).length}/{draft.length})
      </h4>
      <ul className="grid gap-0.5">
        {draft.map((c, i) => (
          <li key={i} className="group/crit flex items-center gap-2">
            <Checkbox
              checked={c.done}
              disabled={!editable || checkCriterion.isLoading}
              onCheckedChange={(checked) =>
                void checkCriterion.execute({ id: task.id, index: i, done: checked === true })
              }
            />
            {editable ? (
              <input
                value={c.text}
                onChange={(e) => setText(i, e.target.value)}
                onPaste={(e) => {
                  // A multi-line paste becomes multiple criteria rows.
                  const text = e.clipboardData.getData('text');
                  if (!text.includes('\n')) return;
                  e.preventDefault();
                  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  const next = [
                    ...draft.slice(0, i),
                    { ...draft[i]!, text: lines[0] ?? '' },
                    ...lines.slice(1).map((l) => ({ text: l, done: false })),
                    ...draft.slice(i + 1),
                  ];
                  setDraft(next);
                  void persist(next);
                }}
                onBlur={() => {
                  if (draft[i]?.text !== task.acceptanceCriteria[i]?.text) void persist(draft);
                }}
                className={cn(
                  'min-w-0 flex-1 bg-transparent text-sm outline-none',
                  c.done && 'text-muted-foreground line-through',
                )}
              />
            ) : (
              <span className={cn('text-sm', c.done && 'text-muted-foreground line-through')}>
                {c.text}
              </span>
            )}
            {editable && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground/50 opacity-0 transition-opacity group-hover/crit:opacity-100 hover:text-destructive"
                aria-label={t(k.common.actions.delete)}
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <button
          type="button"
          onClick={() => setDraft((prev) => [...prev, { text: '', done: false }])}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t(k.tasks.addCriterion)}
        </button>
      )}
    </div>
  );
}

/** "6 files · +214 −38 · touches apps/web, packages/contracts" — live from GitHub. */
function PrScopeLine({ task }: { task: Task }) {
  const { t } = useTranslation();
  const hasRemote = Boolean(task.branch ?? task.prUrl);
  const { data, isLoading } = useTaskPr(hasRemote ? task.id : null);
  if (!hasRemote || (!data && !isLoading)) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {isLoading || !data ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <>
          <span className="tabular-nums">
            {t(k.tasks.v2.diffStats, {
              files: data.changedFiles,
              additions: data.additions,
              deletions: data.deletions,
            })}
          </span>
          {data.areas.length > 0 && (
            <span>· {t(k.tasks.v2.touches, { areas: data.areas.join(', ') })}</span>
          )}
        </>
      )}
    </p>
  );
}

function WorkLinks({ task }: { task: Task }) {
  const { t } = useTranslation();
  if (!task.branch && !task.prUrl) return null;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {task.branch && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono">
            <GitBranch className="size-3" />
            {task.branch}
          </span>
        )}
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="size-3" />
            {t(k.tasks.detail.openPr)}
          </a>
        )}
      </div>
      <PrScopeLine task={task} />
    </div>
  );
}

/** Dependency arrows, display-only — sequencing is rare and set at authoring. */
function DependenciesNote({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const { data } = useTask(taskId);
  if (!data || (data.dependencies.length === 0 && data.dependents.length === 0)) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(['dependencies', 'dependents'] as const).map(
        (kind) =>
          data[kind].length > 0 && (
            <div key={kind} className="grid gap-1">
              <h4 className={SECTION_HEADING}>{t(k.tasks.detail[kind])}</h4>
              <ul className="grid gap-1">
                {data[kind].map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <StatusBadge status={d.status} />
                    <span className="truncate">{d.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ),
      )}
    </div>
  );
}

const kindStyles: Record<string, string> = {
  comment: 'bg-muted text-muted-foreground',
  progress: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  question: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  answer: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
};

/** The task's conversation with a reply box — the last section of every row. */
function ActivityThread({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const { data } = useTask(taskId);
  const addComment = useAddComment();
  const [body, setBody] = useState('');
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const submit = async () => {
    if (!body.trim()) return;
    const res = await addComment.execute({ id: taskId, kind: 'comment', body: body.trim() });
    if (res.e) toast.error(t(res.e.message));
    else setBody('');
  };

  return (
    <div className="grid gap-2">
      <h4 className={SECTION_HEADING}>
        <MessageSquare className="size-3.5" />
        {t(k.tasks.detail.comments)}
      </h4>
      {!data || data.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(k.tasks.detail.noComments)}</p>
      ) : (
        <ul className="grid gap-2">
          {data.comments.map((c) => (
            <li key={c.id} className="rounded-lg border bg-background/60 px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                {c.authorType === 'agent' ? (
                  <Bot className="size-3.5" />
                ) : (
                  <User className="size-3.5" />
                )}
                <span>
                  {t(c.authorType === 'agent' ? k.tasks.detail.agent : k.tasks.detail.you)}
                </span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    kindStyles[c.kind],
                  )}
                >
                  {t(k.tasks.detail.kind[c.kind])}
                </span>
                <span className="ml-auto">{fmtDate(c.createdAt)}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <Textarea
          rows={1}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t(k.tasks.detail.commentPlaceholder)}
          className="min-h-9 flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={addComment.isLoading || !body.trim()}
          onClick={() => void submit()}
        >
          {t(k.tasks.detail.addComment)}
        </Button>
      </div>
    </div>
  );
}

/**
 * The residual protocol moves the rich cards do not cover (dispatch, claim
 * reset, requeue, cancel, draft delete) plus inline priority — a quiet
 * footer, because these are rare.
 */
function StageMoves({ task }: { task: Task }) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const deleteTask = useDeleteTask();
  const update = useUpdateTask();
  const [priority, setPriority] = useState(String(task.priority));
  useEffect(() => setPriority(String(task.priority)), [task.priority]);
  if (isTerminal(task)) return null;

  const go = async (to: 'ready' | 'draft' | 'cancelled') => {
    const res = await transition.execute({ id: task.id, to });
    if (res.e) toast.error(t(res.e.message));
  };

  const savePriority = async () => {
    const next = Math.max(0, Math.min(1000, Number(priority) || 0));
    if (next === task.priority) return;
    const res = await update.execute({ id: task.id, priority: next });
    if (res.e) toast.error(t(res.e.message));
  };

  const busy = transition.isLoading || deleteTask.isLoading;
  // The dispatch gate, visible before the click: a draft without context or
  // criteria cannot go ready (the server refuses too).
  const dispatchBlocked =
    task.status === 'draft' && (!task.context?.trim() || task.acceptanceCriteria.length === 0);
  const moves: Array<{ labelKey: string; to: 'ready' | 'draft' }> = [];
  if (task.status === 'draft') moves.push({ labelKey: k.tasks.actions.markReady, to: 'ready' });
  if (task.status === 'ready') moves.push({ labelKey: k.tasks.actions.backToDraft, to: 'draft' });
  if (task.status === 'in_progress')
    moves.push({ labelKey: k.tasks.actions.resetClaim, to: 'ready' });
  if (task.status === 'changes_requested')
    moves.push({ labelKey: k.tasks.actions.markReady, to: 'ready' });

  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      {moves.map((m) => (
        <Button
          key={m.labelKey}
          size="sm"
          variant="outline"
          disabled={busy || (m.to === 'ready' && dispatchBlocked)}
          title={m.to === 'ready' && dispatchBlocked ? t(k.tasks.errors.dispatchGate) : undefined}
          onClick={() => void go(m.to)}
        >
          {t(m.labelKey)}
        </Button>
      ))}
      {dispatchBlocked && (
        <span className="text-xs text-muted-foreground">{t(k.tasks.errors.dispatchGate)}</span>
      )}
      {task.status === 'draft' && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={busy}
          onClick={() => void deleteTask.execute({ id: task.id })}
        >
          {t(k.tasks.actions.deleteDraft)}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        disabled={busy}
        onClick={() => void go('cancelled')}
      >
        {t(k.tasks.actions.cancelTask)}
      </Button>
      <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        {t(k.tasks.priority)}
        <input
          type="number"
          min={0}
          max={1000}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={() => void savePriority()}
          className="w-14 rounded-md border bg-transparent px-1.5 py-0.5 text-right text-xs tabular-nums outline-none focus:border-primary/50"
        />
      </label>
    </div>
  );
}

/**
 * The full detail body every stage shares — the sheet, dissolved into the
 * row: context, out of scope, criteria, PR, the stage's own actions,
 * attachments, dependencies, activity, then the residual moves.
 */
function ExpandedBody({
  task,
  headline,
  actions,
}: {
  task: Task;
  headline?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 border-t py-3 pr-4 pl-9">
      {headline}
      <InlineArea
        task={task}
        field="context"
        labelKey={k.tasks.taskContext}
        placeholderKey={k.tasks.taskContextHint}
      />
      <InlineArea
        task={task}
        field="outOfScope"
        labelKey={k.tasks.outOfScope}
        placeholderKey={k.tasks.outOfScope}
      />
      <CriteriaEditor task={task} />
      <WorkLinks task={task} />
      {actions}
      <AttachmentsSection taskId={task.id} />
      <DependenciesNote taskId={task.id} />
      <ActivityThread taskId={task.id} />
      <StageMoves task={task} />
    </div>
  );
}

/** The one-paragraph "what changed" the agent recorded when submitting. */
function AgentSummary({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const { data } = useTask(taskId);
  const summary = data?.comments
    .filter((c) => c.authorType === 'agent' && (c.kind === 'comment' || c.kind === 'progress'))
    .at(-1);
  return (
    <div>
      <h4 className={cn(SECTION_HEADING, 'mb-1')}>
        <Bot className="size-3.5" />
        {t(k.tasks.v2.agentSummary)}
      </h4>
      <p className="text-sm whitespace-pre-wrap">{summary?.body ?? t(k.tasks.v2.noSummary)}</p>
    </div>
  );
}

/** Shared inline feedback box for the two "send back" paths. */
function FeedbackBox({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const [feedback, setFeedback] = useState('');

  const sendBack = async () => {
    if (!feedback.trim()) return;
    const res = await transition.execute({
      id: taskId,
      to: 'changes_requested',
      comment: feedback.trim(),
    });
    if (res.e) toast.error(t(res.e.message));
    else onClose();
  };

  return (
    <div className="grid gap-2">
      <Textarea
        autoFocus
        rows={3}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={t(k.tasks.actions.feedbackPlaceholder)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          disabled={transition.isLoading || !feedback.trim()}
          onClick={() => void sendBack()}
        >
          {t(k.tasks.actions.requestChanges)}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t(k.common.actions.cancel)}
        </Button>
      </div>
    </div>
  );
}

/**
 * needs_review: the decision card. "Approve & merge" chains the two server
 * calls; a merge failure leaves the task safely in the merge queue.
 */
export function ReviewCard(props: CardProps) {
  const { task } = props;
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const [givingFeedback, setGivingFeedback] = useState(false);
  const busy = transition.isLoading || merge.isLoading;
  const ciFailing = task.ciState === 'failing';
  const mergeable = Boolean(task.branch ?? task.prUrl) && !ciFailing;

  const approve = async (thenMerge: boolean) => {
    const approved = await transition.execute({ id: task.id, to: 'approved' });
    if (approved.e) {
      toast.error(t(approved.e.message));
      return;
    }
    if (!thenMerge) {
      toast.success(t(k.tasks.v2.approvedToast));
      return;
    }
    const merged = await merge.execute({ id: task.id });
    if (merged.e) toast.error(t(merged.e.message));
    else toast.success(t(k.tasks.v2.mergedToast));
  };

  return (
    <CardShell {...props}>
      <ExpandedBody
        task={task}
        headline={<AgentSummary taskId={task.id} />}
        actions={
          givingFeedback ? (
            <FeedbackBox taskId={task.id} onClose={() => setGivingFeedback(false)} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {mergeable ? (
                <Button size="sm" disabled={busy} onClick={() => void approve(true)}>
                  <GitMerge className="size-4 mr-1" />
                  {t(k.tasks.actions.approveMerge)}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={mergeable ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => void approve(false)}
              >
                {t(k.tasks.actions.approve)}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={busy}
                onClick={() => setGivingFeedback(true)}
              >
                {t(k.tasks.actions.requestChanges)}
              </Button>
              <span className="text-xs text-muted-foreground">
                {ciFailing
                  ? t(k.tasks.v2.mergeBlockedCi)
                  : mergeable
                    ? t(k.tasks.v2.ciGreenHint)
                    : null}
              </span>
            </div>
          )
        }
      />
    </CardShell>
  );
}

/**
 * approved: the merge queue. Merge stays a one-click head action even when
 * collapsed; the expanded row is the same full detail as everywhere else.
 */
export function ApprovedCard(props: CardProps) {
  const { task, expanded } = props;
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const merge = useMergeTask();
  const [givingFeedback, setGivingFeedback] = useState(false);
  const busy = transition.isLoading || merge.isLoading;
  const ciFailing = task.ciState === 'failing';

  const doMerge = async () => {
    const res = await merge.execute({ id: task.id });
    if (res.e) toast.error(t(res.e.message));
    else toast.success(t(k.tasks.v2.mergedToast));
  };

  return (
    <CardShell
      {...props}
      actions={
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={busy || ciFailing} onClick={() => void doMerge()}>
            {merge.isLoading ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <GitMerge className="size-4 mr-1" />
            )}
            {t(merge.isLoading ? k.tasks.v2.merging : k.tasks.actions.merge)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={t(k.tasks.actions.undoApprove)}
            aria-label={t(k.tasks.actions.undoApprove)}
            onClick={() => void transition.execute({ id: task.id, to: 'needs_review' })}
          >
            <Undo2 className="size-4" />
          </Button>
          {ciFailing && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={busy}
              onClick={() => {
                if (!expanded) props.onToggle(task.id);
                setGivingFeedback((open) => !open);
              }}
            >
              {t(k.tasks.actions.requestChanges)}
            </Button>
          )}
        </div>
      }
    >
      <ExpandedBody
        task={task}
        headline={
          <>
            {ciFailing && (
              <p className="text-xs text-destructive">{t(k.tasks.v2.mergeBlockedCi)}</p>
            )}
            <AgentSummary taskId={task.id} />
          </>
        }
        actions={
          givingFeedback ? (
            <FeedbackBox taskId={task.id} onClose={() => setGivingFeedback(false)} />
          ) : undefined
        }
      />
    </CardShell>
  );
}

/** blocked: the agent's question with the answer box right there. */
export function BlockedCard(props: CardProps) {
  const { task, expanded } = props;
  const { t } = useTranslation();
  const { data } = useTask(expanded ? task.id : null);
  const transition = useTransitionTask();
  const [answer, setAnswer] = useState('');
  const question = data?.comments.filter((c) => c.kind === 'question').at(-1)?.body;

  const requeue = async () => {
    if (!answer.trim()) return;
    const res = await transition.execute({ id: task.id, to: 'ready', comment: answer.trim() });
    if (res.e) toast.error(t(res.e.message));
    else setAnswer('');
  };

  return (
    <CardShell {...props}>
      <ExpandedBody
        task={task}
        headline={
          question ? (
            <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
              <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
              <span className="break-words whitespace-pre-wrap">{question}</span>
            </p>
          ) : undefined
        }
        actions={
          <div className="grid gap-2">
            <Textarea
              rows={2}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={t(k.tasks.actions.answerPlaceholder)}
            />
            <div>
              <Button
                size="sm"
                disabled={transition.isLoading || !answer.trim()}
                onClick={() => void requeue()}
              >
                <RotateCcw className="size-4 mr-1" />
                {t(k.tasks.actions.requeue)}
              </Button>
            </div>
          </div>
        }
      />
    </CardShell>
  );
}

/** Everything else: same full detail, no stage-specific headline. */
export function PlainCard(props: CardProps) {
  return (
    <CardShell {...props}>
      <ExpandedBody task={props.task} />
    </CardShell>
  );
}
