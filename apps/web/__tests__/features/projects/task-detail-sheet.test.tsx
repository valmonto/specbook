import { vi } from 'vitest';
import { TaskDetailSheet } from '@/features/projects/components/task-detail-sheet';
import { render, screen } from '../../mocks/providers';
import { installRadixDomShims, makeAction, makeTask } from './helpers';

/**
 * The "Your move" slide-over is now a thin frame around the shared
 * <TaskDetail>. This proves the inbox renders the identical body — including
 * the dependency editor that used to be its exclusive feature — rather than a
 * divergent copy.
 */

const hooks = vi.hoisted(() => ({
  useTask: vi.fn(),
  useAgents: vi.fn(),
  useUpdateTask: vi.fn(),
  useTransitionTask: vi.fn(),
  useMergeTask: vi.fn(),
  useAddComment: vi.fn(),
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
  hooks.useAgents.mockReturnValue({ data: { data: [] } });
  hooks.useUpdateTask.mockReturnValue(makeAction());
  hooks.useTransitionTask.mockReturnValue(makeAction());
  hooks.useMergeTask.mockReturnValue(makeAction());
  hooks.useAddComment.mockReturnValue(makeAction());
  hooks.useTaskPr.mockReturnValue({ data: undefined, isLoading: false });
  hooks.useProjectAreas.mockReturnValue({ data: { areas: [] } });
  hooks.useProjectTasks.mockReturnValue({ data: { data: [] } });
  hooks.useAddDependency.mockReturnValue(makeAction());
  hooks.useRemoveDependency.mockReturnValue(makeAction());
});

const noop = () => {};

describe('TaskDetailSheet', () => {
  it('mounts the shared detail body, dependency editor included', () => {
    const base = makeTask({ status: 'needs_review', title: 'Ship it' });
    hooks.useTask.mockReturnValue({
      data: { ...base, dependencies: [], dependents: [], comments: [] },
    });

    render(<TaskDetailSheet taskId={base.id} onOpenChange={noop} />);

    // The sheet's own chrome (title) plus the shared body's sections.
    expect(screen.getByText('Ship it')).toBeInTheDocument();
    expect(screen.getByText('tasks.detail.dependencies')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'tasks.detail.addDependency' }),
    ).toBeInTheDocument();
    expect(screen.getByText('tasks.detail.comments')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^tasks\.actions\.approve$/ }),
    ).toBeInTheDocument();
  });
});
