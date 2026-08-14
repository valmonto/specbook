import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Bot,
  Check,
  ExternalLink,
  GitBranch,
  GitMerge,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  Plus,
  RotateCcw,
  SendHorizontal,
  TriangleAlert,
  User,
  UserRound,
  X,
} from 'lucide-react';
import type { AcceptanceCriterion, Task } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddComment,
  useClearAssumption,
  useMarkReady,
  useMergeTask,
  useProjectAreas,
  useTask,
  useTaskPr,
  useTransitionTask,
  useUpdateTask,
} from '../hooks/use-projects';
import { AttachmentsSection } from './attachments-section';
import { DependencyEditor } from './dependency-editor';
import { useProjectReadOnly } from './v2/read-only-context';
import { markSingleTaskReady } from './v2/mark-ready-menu';
import { CostLine } from './github-state-badges';

/**
 * The ONE task-detail body, shared by the project board's expanded row and the
 * "Your move" slide-over. Everything the human does to a task after opening it
 * lives here: Notion-style inline spec editing (context, out-of-scope, area,
 * criteria, priority, human-task flag), the live PR/CI/cost surface, the
 * dependency editor + dependents, attachments, the activity thread, and the
 * stage's legal transitions. Consumers own only the chrome around it (the
 * board row header or the sheet header) — never a second copy of the detail.
 */

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

const SECTION_HEADING =
  'flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase';

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
  // Optimistic: after blur the NEW text stays on screen while the save and
  // revalidation run; an error reverts and toasts. undefined = no save in
  // flight (render the server value).
  const [optimistic, setOptimistic] = useState<string | null | undefined>(undefined);
  const serverValue = task[field];
  useEffect(() => {
    if (optimistic !== undefined && (serverValue ?? null) === optimistic) setOptimistic(undefined);
  }, [serverValue, optimistic]);
  const value = optimistic !== undefined ? optimistic : serverValue;
  const readOnly = useProjectReadOnly();
  const editable = !isTerminal(task) && !readOnly;
  if (!value && !editable) return null;

  const save = async () => {
    setEditing(false);
    const next = draft.trim() || null;
    if ((value ?? null) === next) return;
    setOptimistic(next);
    const res = await update.execute({ id: task.id, [field]: next });
    if (res.e) {
      setOptimistic(undefined);
      toast.error(t(res.e.message));
    }
  };

  return (
    <div className="grid grid-cols-1 gap-1">
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
          className="-mx-1.5 w-[calc(100%+0.75rem)] min-w-0 resize-none rounded-md bg-muted/40 px-1.5 py-0.5 text-sm leading-relaxed whitespace-pre-wrap outline-none [field-sizing:content]"
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
            '-mx-1.5 rounded-md px-1.5 py-0.5 text-left text-sm leading-relaxed break-words whitespace-pre-wrap',
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
 * The feature/flow label as a free-text combobox — type any label, or pick one
 * already used on this project. Only rendered while editable; the board also
 * shows the value as a row chip.
 */
function AreaEditor({ task }: { task: Task }) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  const readOnly = useProjectReadOnly();
  const editable = !isTerminal(task) && !readOnly;
  const [value, setValue] = useState(task.area ?? '');
  useEffect(() => setValue(task.area ?? ''), [task.area]);
  const { data: areaData } = useProjectAreas(editable ? task.projectId : null);
  if (!editable) return null;

  const save = async () => {
    const next = value.trim() || null;
    if ((task.area ?? null) === next) return;
    const res = await update.execute({ id: task.id, area: next });
    if (res.e) {
      setValue(task.area ?? '');
      toast.error(t(res.e.message));
    }
  };

  return (
    <div className="grid grid-cols-1 gap-1">
      <h4 className={SECTION_HEADING}>{t(k.tasks.area)}</h4>
      <Combobox items={areaData?.areas ?? []} inputValue={value} onInputValueChange={setValue}>
        <ComboboxInput
          placeholder={t(k.tasks.areaPlaceholder)}
          className="w-full sm:w-72"
          showClear
          onBlur={() => void save()}
        />
        <ComboboxContent>
          <ComboboxEmpty>{t(k.tasks.noArea)}</ComboboxEmpty>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

/**
 * The checklist, live: criterion text edits in place, rows add/remove inline.
 * Text edits save the whole array (small by design), preserving done flags.
 * Ticking is the AGENT's act (progress = criteria checked over MCP); the box
 * here is a read-only indicator.
 */
function CriteriaEditor({ task }: { task: Task }) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  const readOnly = useProjectReadOnly();
  const editable = !isTerminal(task) && !readOnly;
  const [draft, setDraft] = useState<AcceptanceCriterion[]>(task.acceptanceCriteria);
  // While an input in the list has focus, the user is mid-edit — server
  // refreshes must not clobber the local rows (e.g. a just-added empty one).
  const focusedRef = useRef(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!focusedRef.current) setDraft(task.acceptanceCriteria);
  }, [task.acceptanceCriteria]);

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
  const addRow = (after: number) => {
    setDraft((prev) => [
      ...prev.slice(0, after + 1),
      { text: '', done: false },
      ...prev.slice(after + 1),
    ]);
    setFocusIndex(after + 1);
  };
  const hasEmptyRow = draft.some((c) => !c.text.trim());

  return (
    <div className="grid grid-cols-1 gap-1">
      <h4 className={SECTION_HEADING}>
        {t(k.tasks.acceptanceCriteria)} ({draft.filter((c) => c.done).length}/{draft.length})
      </h4>
      <ul className="grid grid-cols-1 gap-0.5">
        {draft.map((c, i) => (
          <li key={i} className="group/crit flex items-start gap-2">
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                c.done
                  ? 'border-emerald-500 bg-emerald-500 text-white'
                  : 'border-muted-foreground/40',
              )}
            >
              {c.done && <Check className="size-3" />}
            </span>
            {editable ? (
              /* A textarea, not an input: criterion text must WRAP on phone
                 widths instead of scrolling inside a single line. rows=1 +
                 the inline-ref autosize (re-runs every render) grow it with
                 content; Enter never inserts a newline — it adds a row. */
              <textarea
                rows={1}
                ref={(el) => {
                  if (el) {
                    el.style.height = 'auto';
                    el.style.height = `${el.scrollHeight}px`;
                  }
                  if (el && focusIndex === i) {
                    el.focus();
                    setFocusIndex(null);
                  }
                }}
                value={c.text}
                onFocus={() => {
                  focusedRef.current = true;
                }}
                onChange={(e) => setText(i, e.target.value)}
                onKeyDown={(e) => {
                  // Enter on a non-empty row inserts the next one below it;
                  // it never becomes a literal newline inside the criterion.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (c.text.trim()) addRow(i);
                  }
                }}
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
                  focusedRef.current = false;
                  if (draft[i]?.text !== task.acceptanceCriteria[i]?.text) void persist(draft);
                }}
                className={cn(
                  'min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-sm break-words outline-none',
                  c.done && 'text-muted-foreground line-through',
                )}
              />
            ) : (
              <span className={cn('min-w-0 flex-1 text-sm break-words', c.done && 'text-muted-foreground line-through')}>
                {c.text}
              </span>
            )}
            {editable && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="mt-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/crit:opacity-100 hover:text-destructive pointer-coarse:opacity-100"
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
          disabled={hasEmptyRow}
          onClick={() => addRow(draft.length - 1)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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
    <div className="grid grid-cols-1 gap-1.5">
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

/**
 * Dependencies: the full relationship section — the "Depends on" editor
 * (add/remove your own edges) and the read-only "Blocks" list (the reverse
 * edge, edited from the other end). Both live in {@link DependencyEditor} so
 * the two render as one coherent block. Waits for the full task read so the
 * editor has the real edge list.
 */
function DependenciesSection({ taskId }: { taskId: string }) {
  const { data } = useTask(taskId);
  if (!data) return null;
  return <DependencyEditor task={data} />;
}

const kindStyles: Record<string, string> = {
  comment: 'bg-muted text-muted-foreground',
  progress: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  question: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  answer: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  note: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/20 ring-inset',
};

/** The task's conversation with a reply box — the last section of every row. */
function ActivityThread({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation();
  const readOnly = useProjectReadOnly();
  const { data } = useTask(taskId);
  const addComment = useAddComment();
  const [body, setBody] = useState('');
  const [asNote, setAsNote] = useState(false);
  const canNote = data?.status === 'in_progress' && Boolean(data?.claimedBy);
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const submit = async () => {
    if (!body.trim()) return;
    const res = await addComment.execute({
      id: taskId,
      kind: asNote && canNote ? 'note' : 'comment',
      body: body.trim(),
    });
    if (res.e) toast.error(t(res.e.message));
    else setBody('');
  };

  return (
    <div className="grid grid-cols-1 gap-2">
      <h4 className={SECTION_HEADING}>
        <MessageSquare className="size-3.5" />
        {t(k.tasks.detail.comments)}
      </h4>
      {!data || data.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(k.tasks.detail.noComments)}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {data.comments.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {c.authorType === 'agent' ? (
                  <Bot className="size-3.5" />
                ) : (
                  <User className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
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
                  {c.kind === 'note' && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[10px]',
                        c.ackedAt
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-muted-foreground/70',
                      )}
                    >
                      {c.ackedAt && <Check className="size-3" />}
                      {t(c.ackedAt ? k.tasks.detail.noteSeen : k.tasks.detail.notePending)}
                    </span>
                  )}
                  <span className="ml-auto tabular-nums" title={fmtDate(c.createdAt)}>
                    {ago(c.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {/* Composer: quiet until it has text; Cmd/Ctrl+Enter sends. */}
      {readOnly ? null : (
        <div className="flex items-end gap-1.5">
          <textarea
            rows={1}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={t(k.tasks.detail.commentPlaceholder)}
            className="min-h-8 flex-1 resize-none rounded-md bg-muted/40 px-2.5 py-1.5 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground/60 focus:bg-muted/60"
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground disabled:opacity-30"
            disabled={addComment.isLoading || !body.trim()}
            aria-label={t(k.tasks.detail.addComment)}
            onClick={() => void submit()}
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      )}
      {readOnly || !canNote ? null : (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={asNote}
            onChange={(e) => setAsNote(e.target.checked)}
            className="size-3.5 accent-sky-600"
          />
          {t(k.tasks.detail.noteToggle)}
        </label>
      )}
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
      <p className="text-sm break-words whitespace-pre-wrap">{summary?.body ?? t(k.tasks.v2.noSummary)}</p>
    </div>
  );
}

/** Shared inline feedback box for the "send back" paths (→ changes_requested). */
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
    <div className="grid grid-cols-1 gap-2">
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
 * The stage-specific headline that opens the detail: the agent's summary on
 * the review/merge stages, the agent's open question on a blocked task.
 */
function StageHeadline({ task }: { task: Task }) {
  const { t } = useTranslation();
  const { data } = useTask(task.status === 'blocked' ? task.id : null);
  if (task.status === 'needs_review' || task.status === 'approved') {
    return (
      <>
        {task.status === 'approved' && task.ciState === 'failing' && (
          <p className="text-xs text-destructive">{t(k.tasks.v2.mergeBlockedCi)}</p>
        )}
        <AgentSummary taskId={task.id} />
      </>
    );
  }
  if (task.status === 'blocked') {
    const question = data?.comments.filter((c) => c.kind === 'question').at(-1)?.body;
    return question ? (
      <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-300">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
        <span className="break-words whitespace-pre-wrap">{question}</span>
      </p>
    ) : null;
  }
  return null;
}

/**
 * needs_review: approve, approve & merge (chains the two calls; a merge
 * failure leaves the task safely in the merge queue), or send back.
 */
function ReviewActions({ task }: { task: Task }) {
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

  if (givingFeedback) return <FeedbackBox taskId={task.id} onClose={() => setGivingFeedback(false)} />;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {mergeable && (
        <Button size="sm" disabled={busy} onClick={() => void approve(true)}>
          <GitMerge className="size-4 mr-1" />
          {t(k.tasks.actions.approveMerge)}
        </Button>
      )}
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
        {ciFailing ? t(k.tasks.v2.mergeBlockedCi) : mergeable ? t(k.tasks.v2.ciGreenHint) : null}
      </span>
    </div>
  );
}

/**
 * approved (the merge queue). The board row's collapsed head owns the "land
 * it" merge, so `landInHeader` drops the manual mark-merged here to avoid a
 * double button; the slide-over has no head and keeps it.
 */
function ApprovedActions({ task, landInHeader }: { task: Task; landInHeader: boolean }) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const [givingFeedback, setGivingFeedback] = useState(false);
  const busy = transition.isLoading;

  if (givingFeedback) return <FeedbackBox taskId={task.id} onClose={() => setGivingFeedback(false)} />;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!landInHeader && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void transition.execute({ id: task.id, to: 'done' })}
        >
          {t(k.tasks.actions.markMerged)}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void transition.execute({ id: task.id, to: 'needs_review' })}
      >
        {t(k.tasks.actions.undoApprove)}
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
    </div>
  );
}

/** blocked: the agent's question is the headline; here is the answer box. */
function BlockedActions({ task }: { task: Task }) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const [answer, setAnswer] = useState('');

  const requeue = async () => {
    if (!answer.trim()) return;
    const res = await transition.execute({ id: task.id, to: 'ready', comment: answer.trim() });
    if (res.e) toast.error(t(res.e.message));
    else setAnswer('');
  };

  return (
    <div className="grid grid-cols-1 gap-2">
      <Textarea
        rows={2}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder={t(k.tasks.actions.answerPlaceholder)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={transition.isLoading || !answer.trim()}
          onClick={() => void requeue()}
        >
          <RotateCcw className="size-4 mr-1" />
          {t(k.tasks.actions.requeue)}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={transition.isLoading}
          onClick={() => void transition.execute({ id: task.id, to: 'in_progress' })}
        >
          {t(k.tasks.actions.resume)}
        </Button>
      </div>
    </div>
  );
}

/**
 * done's one legal move: reopen with feedback (→ changes_requested). The
 * feedback comment is the round-2 spec delta and the server refuses the
 * transition without it.
 */
function ReopenMove({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (task.status !== 'done') return null;
  return (
    <div className="grid grid-cols-1 gap-2 border-t pt-3">
      {open ? (
        <FeedbackBox taskId={task.id} onClose={() => setOpen(false)} />
      ) : (
        <Button size="sm" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
          <RotateCcw className="size-3.5 mr-1" />
          {t(k.tasks.actions.reopenWithFeedback)}
        </Button>
      )}
    </div>
  );
}

/** Rich, stage-specific action block (approve/merge, answer, undo, …). */
function StageActions({ task, landInHeader }: { task: Task; landInHeader: boolean }) {
  if (task.status === 'needs_review') return <ReviewActions task={task} />;
  if (task.status === 'approved') return <ApprovedActions task={task} landInHeader={landInHeader} />;
  if (task.status === 'blocked') return <BlockedActions task={task} />;
  return null;
}

/**
 * The residual protocol moves the rich actions do not cover (dispatch, claim
 * reset, send-back-to-draft), the human-task flag, and priority — a quiet
 * footer, because these are rare. Destructive moves (cancel, draft delete)
 * render here only when the chrome around the detail does not already host them
 * (the board row's overflow menu does; the slide-over does not).
 */
function MovesFooter({
  task,
  destructiveInMenu,
}: {
  task: Task;
  destructiveInMenu: boolean;
}) {
  const { t } = useTranslation();
  const transition = useTransitionTask();
  const markReady = useMarkReady();
  const update = useUpdateTask();
  const [priority, setPriority] = useState(String(task.priority));
  useEffect(() => setPriority(String(task.priority)), [task.priority]);
  if (isTerminal(task)) return null;

  const go = async (to: 'ready' | 'draft' | 'cancelled') => {
    // Dispatching a draft cascades: mark-ready also promotes transitive draft
    // prerequisites and toasts any it pulled in. No confirmation — direct action.
    if (to === 'ready' && task.status === 'draft') {
      await markSingleTaskReady(markReady, task, t);
      return;
    }
    const res = await transition.execute({ id: task.id, to });
    if (res.e) toast.error(t(res.e.message));
  };

  const savePriority = async () => {
    const next = Math.max(0, Math.min(1000, Number(priority) || 0));
    if (next === task.priority) return;
    const res = await update.execute({ id: task.id, priority: next });
    if (res.e) toast.error(t(res.e.message));
  };

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

  const busy = transition.isLoading || markReady.isLoading || update.isLoading;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      {moves.map((m) => (
        <Button
          key={m.labelKey}
          size="sm"
          variant={m.to === 'ready' ? 'default' : 'outline'}
          disabled={
            transition.isLoading || markReady.isLoading || (m.to === 'ready' && dispatchBlocked)
          }
          title={m.to === 'ready' && dispatchBlocked ? t(k.tasks.errors.dispatchGate) : undefined}
          onClick={() => void go(m.to)}
        >
          {t(m.labelKey)}
        </Button>
      ))}
      {dispatchBlocked && (
        <span
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={t(k.tasks.errors.dispatchGate)}
        >
          {t(k.tasks.errors.dispatchGate)}
        </span>
      )}
      {/* The slide-over has no overflow menu, so the destructive moves land
          here; on the board they live in the row menu instead. */}
      {!destructiveInMenu && task.status === 'draft' && (
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          disabled={busy}
          onClick={() => void go('cancelled')}
        >
          {t(k.tasks.actions.deleteDraft)}
        </Button>
      )}
      {!destructiveInMenu && task.status !== 'draft' && (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy}
          onClick={() => void go('cancelled')}
        >
          {t(k.tasks.actions.cancelTask)}
        </Button>
      )}
      <label
        className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        title={t(k.tasks.humanTaskToggle)}
      >
        <input
          type="checkbox"
          checked={task.isHumanTask}
          disabled={busy}
          onChange={(e) => void update.execute({ id: task.id, isHumanTask: e.target.checked })}
          className="size-3.5 accent-orange-600"
        />
        <span className="inline-flex items-center gap-1">
          <UserRound className="size-3.5" />
          {t(k.tasks.humanTask)}
        </span>
      </label>
      <label
        className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
        title={t(k.tasks.priority)}
      >
        P
        <input
          type="number"
          min={0}
          max={1000}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={() => void savePriority()}
          className="w-10 rounded-md bg-transparent px-1 py-0.5 text-right text-xs tabular-nums outline-none [appearance:textfield] hover:bg-muted/50 focus:bg-muted/60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </label>
    </div>
  );
}

export interface TaskDetailProps {
  task: Task;
  /**
   * True when the surrounding chrome (the board row's collapsed head) already
   * offers the approved "land it" merge action — the body then omits the
   * duplicate mark-merged button.
   */
  landInHeader?: boolean;
  /**
   * True when the surrounding chrome offers an overflow menu for destructive
   * moves (cancel, delete draft) — the board row does; the slide-over does not.
   */
  destructiveInMenu?: boolean;
}

/**
 * The assumption flag, surfaced prominently: what the agent assumed, why it's
 * the most defensible read, and how to verify — the record that held this task
 * out of full-auto's auto-merge. Clearing it is the human's review-time veto
 * (hidden in read-only chrome); once cleared, the task is free to merge.
 */
function AssumptionSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const readOnly = useProjectReadOnly();
  const clear = useClearAssumption();
  const flag = task.assumptionFlag;
  if (!flag) return null;
  const clearFlag = async () => {
    const res = await clear.execute({ id: task.id });
    if (res.e) toast.error(t(res.e.message));
  };
  const rows: Array<[string, string]> = [
    [t(k.tasks.assumption.what), flag.what],
    [t(k.tasks.assumption.why), flag.why],
    [t(k.tasks.assumption.howToVerify), flag.howToVerify],
  ];
  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className={cn(SECTION_HEADING, 'text-amber-700 dark:text-amber-300')}>
          <TriangleAlert className="size-3.5" />
          {t(k.tasks.assumption.heading)}
        </h4>
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={clear.isLoading}
            onClick={() => void clearFlag()}
          >
            {t(k.tasks.assumption.clear)}
          </Button>
        )}
      </div>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_1fr] gap-2">
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {label}
            </dt>
            <dd className="break-words whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The shared detail body. Both the board's expanded row and the "Your move"
 * slide-over render exactly this — the single source of truth for what a task
 * detail shows and lets you do.
 */
export function TaskDetail({ task, landInHeader = false, destructiveInMenu = false }: TaskDetailProps) {
  const readOnly = useProjectReadOnly();
  return (
    <div className="grid grid-cols-1 gap-4">
      <StageHeadline task={task} />
      <AssumptionSection task={task} />
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
      <AreaEditor task={task} />
      <CriteriaEditor task={task} />
      <WorkLinks task={task} />
      <CostLine task={task} />
      {readOnly ? null : <StageActions task={task} landInHeader={landInHeader} />}
      <AttachmentsSection taskId={task.id} readOnly={readOnly} />
      <DependenciesSection taskId={task.id} />
      <ActivityThread taskId={task.id} />
      {readOnly ? null : <MovesFooter task={task} destructiveInMenu={destructiveInMenu} />}
      {readOnly ? null : <ReopenMove task={task} />}
    </div>
  );
}
