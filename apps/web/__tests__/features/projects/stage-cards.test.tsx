import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, waitFor, within } from '@testing-library/react';
import {
  ApprovedCard,
  PlainCard,
  ReviewCard,
} from '@/features/projects/components/v2/stage-cards';
import { render, screen } from '../../mocks/providers';
import { deferred, installRadixDomShims, makeAction, makeTask } from './helpers';

/**
 * The v2 row contract, tested where the browser click-throughs used to be
 * the only proof: accordion bodies, the overflow menu with the dispatch
 * gate, the criteria editor's protocol, optimistic inline saves, and the
 * review/merge action wiring. Hooks are mocked at the module seam — these
 * are component-behavior tests, not API tests.
 */

const hooks = vi.hoisted(() => ({
  useTransitionTask: vi.fn(),
  useMergeTask: vi.fn(),
  useUpdateTask: vi.fn(),
  useDeleteTask: vi.fn(),
  useAddComment: vi.fn(),
  useCheckCriterion: vi.fn(),
  useTask: vi.fn(),
  useTaskPr: vi.fn(),
  // Pulled in by the shared <TaskDetail> body: the area combobox and the
  // dependency editor.
  useProjectAreas: vi.fn(),
  useProjectTasks: vi.fn(),
  useAddDependency: vi.fn(),
  useRemoveDependency: vi.fn(),
}));

vi.mock('@/features/projects/hooks/use-projects', () => hooks);
vi.mock('@/features/projects/hooks/use-attachments', () => ({
  useTaskAttachments: () => ({ data: { data: [] }, mutate: vi.fn() }),
  useUploadAttachment: () => ({ upload: vi.fn(), isUploading: false, error: null }),
  useDeleteAttachment: () => ({ remove: vi.fn(), isDeleting: false }),
}));

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  hooks.useTransitionTask.mockReturnValue(makeAction());
  hooks.useMergeTask.mockReturnValue(makeAction());
  hooks.useUpdateTask.mockReturnValue(makeAction());
  hooks.useDeleteTask.mockReturnValue(makeAction());
  hooks.useAddComment.mockReturnValue(makeAction());
  hooks.useCheckCriterion.mockReturnValue(makeAction());
  hooks.useTask.mockReturnValue({ data: undefined });
  hooks.useTaskPr.mockReturnValue({ data: undefined, isLoading: false });
  hooks.useProjectAreas.mockReturnValue({ data: { areas: [] } });
  hooks.useProjectTasks.mockReturnValue({ data: { data: [] } });
  hooks.useAddDependency.mockReturnValue(makeAction());
  hooks.useRemoveDependency.mockReturnValue(makeAction());
});

const noop = () => {};

describe('accordion body', () => {
  it('collapsed rows render no detail sections; expanded rows render them all', () => {
    const task = makeTask({ acceptanceCriteria: [{ text: 'One', done: false }] });
    const { rerender } = render(
      <PlainCard task={task} expanded={false} onToggle={noop} />,
    );
    expect(screen.queryByText('tasks.taskContext')).not.toBeInTheDocument();

    rerender(<PlainCard task={task} expanded onToggle={noop} />);
    expect(screen.getByText('tasks.taskContext')).toBeInTheDocument();
    expect(screen.getByText(/tasks\.acceptanceCriteria/)).toBeInTheDocument();
    expect(screen.getByText('attachments.title')).toBeInTheDocument();
    expect(screen.getByText('tasks.detail.comments')).toBeInTheDocument();
  });
});

describe('row overflow menu', () => {
  it('offers the draft moves, with Mark ready blocked by the dispatch gate', async () => {
    render(
      <PlainCard
        task={makeTask({ status: 'draft', context: null, acceptanceCriteria: [] })}
        expanded={false}
        onToggle={noop}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'tasks.actions.cancelTask' }));

    const markReady = await screen.findByRole('menuitem', { name: 'tasks.actions.markReady' });
    expect(markReady).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'tasks.actions.deleteDraft' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'tasks.actions.cancelTask' })).toBeInTheDocument();
  });

  it('enables Mark ready once the gate is satisfiable, and fires the transition', async () => {
    const transition = makeAction();
    hooks.useTransitionTask.mockReturnValue(transition);
    const task = makeTask({
      status: 'draft',
      context: 'ctx',
      acceptanceCriteria: [{ text: 'One', done: false }],
    });
    render(<PlainCard task={task} expanded={false} onToggle={noop} />);
    await userEvent.click(screen.getByRole('button', { name: 'tasks.actions.cancelTask' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'tasks.actions.markReady' }));
    expect(transition.execute).toHaveBeenCalledWith({ id: task.id, to: 'ready' });
  });

  it('renders no menu on terminal tasks', () => {
    render(<PlainCard task={makeTask({ status: 'done' })} expanded={false} onToggle={noop} />);
    expect(
      screen.queryByRole('button', { name: 'tasks.actions.cancelTask' }),
    ).not.toBeInTheDocument();
  });
});

describe('criteria editor', () => {
  const draftTask = () =>
    makeTask({
      status: 'draft',
      acceptanceCriteria: [
        { text: 'First', done: true },
        { text: 'Second', done: false },
      ],
    });

  it('criteria checkboxes are read-only indicators — ticking is the agent’s act', () => {
    render(<PlainCard task={draftTask()} expanded onToggle={noop} />);
    // The criteria section carries no interactive checkbox (the human-task
    // toggle in the footer is a separate control).
    const section = screen.getByText(/tasks\.acceptanceCriteria/).closest('div')!;
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('Enter on a non-empty row inserts a focused row below and blocks adding more', async () => {
    render(<PlainCard task={draftTask()} expanded onToggle={noop} />);
    const section = screen.getByText(/tasks\.acceptanceCriteria/).closest('div')!;
    const first = screen.getByDisplayValue('First');
    first.focus();
    await userEvent.keyboard('{Enter}');

    expect(within(section).getAllByRole('textbox')).toHaveLength(3);
    expect(document.activeElement).toHaveDisplayValue('');
    expect(screen.getByRole('button', { name: /tasks\.addCriterion/ })).toBeDisabled();

    // Enter on the empty row is a no-op.
    await userEvent.keyboard('{Enter}');
    expect(within(section).getAllByRole('textbox')).toHaveLength(3);
  });

  it('a multi-line paste becomes multiple rows and persists once', async () => {
    const update = makeAction();
    hooks.useUpdateTask.mockReturnValue(update);
    const task = draftTask();
    render(<PlainCard task={task} expanded onToggle={noop} />);

    fireEvent.paste(screen.getByDisplayValue('Second'), {
      clipboardData: { getData: () => 'A\nB\nC' },
    });

    await waitFor(() =>
      expect(update.execute).toHaveBeenCalledWith({
        id: task.id,
        acceptanceCriteria: [
          { text: 'First', done: true },
          { text: 'A', done: false },
          { text: 'B', done: false },
          { text: 'C', done: false },
        ],
      }),
    );
  });
});

describe('dependency editor on the board', () => {
  it('renders the depends-on editor (add + remove) in the expanded row', () => {
    const task = makeTask({ status: 'draft' });
    hooks.useTask.mockReturnValue({
      data: {
        ...task,
        dependencies: [
          { id: 'dep-1', title: 'Upstream task', status: 'ready' as const },
        ],
        dependents: [],
        comments: [],
      },
    });
    hooks.useProjectTasks.mockReturnValue({
      data: { data: [makeTask({ id: 'cand-1', title: 'Another task' })] },
    });

    render(<PlainCard task={task} expanded onToggle={noop} />);

    // The section, its existing edge with a remove affordance, and the picker.
    expect(screen.getByText('tasks.detail.dependencies')).toBeInTheDocument();
    expect(screen.getByText('Upstream task')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'tasks.detail.removeDependency' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'tasks.detail.addDependency' }),
    ).toBeInTheDocument();
  });
});

describe('optimistic inline save', () => {
  it('keeps the new value on screen while the request is in flight', async () => {
    const flight = deferred<{ e: null; d: null }>();
    const update = makeAction(vi.fn().mockReturnValue(flight.promise));
    hooks.useUpdateTask.mockReturnValue(update);
    const task = makeTask({ status: 'draft', context: 'Old context' });
    render(<PlainCard task={task} expanded onToggle={noop} />);

    await userEvent.click(screen.getByText('Old context'));
    const contextSection = screen.getByText('tasks.taskContext').closest('div')!;
    const editor = within(contextSection).getByRole('textbox');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'New context');
    fireEvent.blur(editor);

    // Mid-flight: the NEW text renders — no old-value flash.
    expect(screen.getByText('New context')).toBeInTheDocument();
    expect(screen.queryByText('Old context')).not.toBeInTheDocument();

    flight.resolve({ e: null, d: null });
    await waitFor(() => expect(screen.getByText('New context')).toBeInTheDocument());
  });

  it('reverts to the server value when the save fails', async () => {
    const update = makeAction(
      vi.fn().mockResolvedValue({ e: new Error('tasks.errors.notFound'), d: null }),
    );
    hooks.useUpdateTask.mockReturnValue(update);
    render(
      <PlainCard task={makeTask({ status: 'draft', context: 'Old context' })} expanded onToggle={noop} />,
    );

    await userEvent.click(screen.getByText('Old context'));
    const contextSection = screen.getByText('tasks.taskContext').closest('div')!;
    const editor = within(contextSection).getByRole('textbox');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Doomed edit');
    fireEvent.blur(editor);

    await waitFor(() => expect(screen.getByText('Old context')).toBeInTheDocument());
    expect(screen.queryByText('Doomed edit')).not.toBeInTheDocument();
  });
});

describe('review card', () => {
  const reviewTask = () =>
    makeTask({ status: 'needs_review', branch: 'feat/x', prUrl: 'https://x', ciState: 'passing' });

  it('Approve & merge chains the transition then the merge', async () => {
    const calls: string[] = [];
    const transition = makeAction(
      vi.fn().mockImplementation(async () => {
        calls.push('approve');
        return { e: null, d: null };
      }),
    );
    const merge = makeAction(
      vi.fn().mockImplementation(async () => {
        calls.push('merge');
        return { e: null, d: null };
      }),
    );
    hooks.useTransitionTask.mockReturnValue(transition);
    hooks.useMergeTask.mockReturnValue(merge);
    const task = reviewTask();
    render(<ReviewCard task={task} expanded onToggle={noop} />);

    await userEvent.click(screen.getByRole('button', { name: /tasks\.actions\.approveMerge/ }));
    await waitFor(() => expect(calls).toEqual(['approve', 'merge']));
    expect(transition.execute).toHaveBeenCalledWith({ id: task.id, to: 'approved' });
    expect(merge.execute).toHaveBeenCalledWith({ id: task.id });
  });

  it('Approve alone never merges', async () => {
    const merge = makeAction();
    hooks.useMergeTask.mockReturnValue(merge);
    render(<ReviewCard task={reviewTask()} expanded onToggle={noop} />);

    await userEvent.click(screen.getByRole('button', { name: /^tasks\.actions\.approve$/ }));
    await waitFor(() =>
      expect(hooks.useTransitionTask.mock.results.length).toBeGreaterThan(0),
    );
    expect(merge.execute).not.toHaveBeenCalled();
  });

  it('failing CI removes Approve & merge and states why', () => {
    render(
      <ReviewCard task={{ ...reviewTask(), ciState: 'failing' }} expanded onToggle={noop} />,
    );
    expect(
      screen.queryByRole('button', { name: /tasks\.actions\.approveMerge/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('tasks.v2.mergeBlockedCi')).toBeInTheDocument();
  });
});

describe('approved card (merge queue)', () => {
  it('merges green rows with one click, and blocks CI-failing ones', async () => {
    const merge = makeAction();
    hooks.useMergeTask.mockReturnValue(merge);
    const green = makeTask({ status: 'approved', ciState: 'passing', prNumber: 12 });
    const { rerender } = render(<ApprovedCard task={green} expanded={false} onToggle={noop} />);

    const mergeBtn = screen.getByRole('button', { name: 'tasks.actions.merge' });
    expect(mergeBtn).toBeEnabled();
    await userEvent.click(mergeBtn);
    expect(merge.execute).toHaveBeenCalledWith({ id: green.id });

    rerender(
      <ApprovedCard
        task={{ ...green, ciState: 'failing' }}
        expanded={false}
        onToggle={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'tasks.actions.merge' })).toBeDisabled();
  });

  it('a closed PR offers ONLY Mark merged, with the hint — the server merge can only error', async () => {
    const transition = makeAction();
    hooks.useTransitionTask.mockReturnValue(transition);
    const closed = makeTask({
      status: 'approved',
      ciState: 'passing',
      prState: 'closed',
      prNumber: 12,
    });
    render(<ApprovedCard task={closed} expanded={false} onToggle={noop} />);

    expect(
      screen.queryByRole('button', { name: 'tasks.actions.merge' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('tasks.v2.prClosedHint')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'tasks.actions.markMerged' }));
    expect(transition.execute).toHaveBeenCalledWith({ id: closed.id, to: 'done' });
  });
});
