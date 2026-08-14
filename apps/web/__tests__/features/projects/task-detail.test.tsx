import { vi } from 'vitest';
import { TaskDetail } from '@/features/projects/components/task-detail';
import { render, screen } from '../../mocks/providers';
import { installRadixDomShims, makeAction, makeTask } from './helpers';

/**
 * The shared task-detail body: the single source of truth rendered by BOTH the
 * project board's expanded row and the "Your move" slide-over. This proves the
 * union of capabilities renders in one place — most importantly the dependency
 * editor, which used to live only in the sheet.
 */

const hooks = vi.hoisted(() => ({
  useUpdateTask: vi.fn(),
  useTransitionTask: vi.fn(),
  useMergeTask: vi.fn(),
  useAddComment: vi.fn(),
  useTask: vi.fn(),
  useTaskPr: vi.fn(),
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
  hooks.useUpdateTask.mockReturnValue(makeAction());
  hooks.useTransitionTask.mockReturnValue(makeAction());
  hooks.useMergeTask.mockReturnValue(makeAction());
  hooks.useAddComment.mockReturnValue(makeAction());
  hooks.useTaskPr.mockReturnValue({ data: undefined, isLoading: false });
  hooks.useProjectAreas.mockReturnValue({ data: { areas: [] } });
  hooks.useProjectTasks.mockReturnValue({
    data: { data: [makeTask({ id: 'cand-1', title: 'Another task' })] },
  });
  hooks.useAddDependency.mockReturnValue(makeAction());
  hooks.useRemoveDependency.mockReturnValue(makeAction());
});

const fullTask = (overrides = {}) => {
  const base = makeTask({
    status: 'needs_review',
    context: 'The spec',
    branch: 'feat/x',
    prUrl: 'https://x',
    ciState: 'passing',
    costUsdCents: 250,
    acceptanceCriteria: [{ text: 'It works', done: false }],
    ...overrides,
  });
  return {
    ...base,
    dependencies: [{ id: 'dep-1', title: 'Upstream task', status: 'ready' as const }],
    dependents: [{ id: 'down-1', title: 'Downstream task', status: 'draft' as const }],
    comments: [],
  };
};

describe('TaskDetail (shared body)', () => {
  it('renders the union: spec, criteria, cost, attachments, comments, deps editor, transitions', () => {
    const task = fullTask();
    hooks.useTask.mockReturnValue({ data: task });

    render(<TaskDetail task={task} />);

    // Spec + criteria (inline-editable) and the live cost line.
    expect(screen.getByText('tasks.taskContext')).toBeInTheDocument();
    expect(screen.getByText(/tasks\.acceptanceCriteria/)).toBeInTheDocument();
    expect(screen.getByText(/tasks\.cost\.label/)).toBeInTheDocument();

    // Attachments + activity thread.
    expect(screen.getByText('attachments.title')).toBeInTheDocument();
    expect(screen.getByText('tasks.detail.comments')).toBeInTheDocument();

    // The dependency EDITOR (add + remove) and the read-only dependents — the
    // capability that used to be sheet-only, now on the board too.
    expect(screen.getByText('tasks.detail.dependencies')).toBeInTheDocument();
    expect(screen.getByText('Upstream task')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'tasks.detail.addDependency' }),
    ).toBeInTheDocument();
    expect(screen.getByText('tasks.detail.dependents')).toBeInTheDocument();
    expect(screen.getByText('Downstream task')).toBeInTheDocument();

    // The stage's transitions (needs_review → approve / approve & merge).
    expect(screen.getByRole('button', { name: /^tasks\.actions\.approve$/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /tasks\.actions\.approveMerge/ }),
    ).toBeInTheDocument();

    // The human-task toggle (was sheet-only, via the edit form).
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('offers Mark merged in the body only when the chrome does not own the merge (slide-over)', () => {
    const task = fullTask({ status: 'approved' });
    hooks.useTask.mockReturnValue({ data: task });

    const { rerender } = render(<TaskDetail task={task} />);
    // Slide-over: no head merge button, so the body carries mark-merged.
    expect(
      screen.getByRole('button', { name: 'tasks.actions.markMerged' }),
    ).toBeInTheDocument();

    // Board: the collapsed head owns "land it", so the body drops the dup.
    rerender(<TaskDetail task={task} landInHeader />);
    expect(
      screen.queryByRole('button', { name: 'tasks.actions.markMerged' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'tasks.actions.undoApprove' }),
    ).toBeInTheDocument();
  });
});
