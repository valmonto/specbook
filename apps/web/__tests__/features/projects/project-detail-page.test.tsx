import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import ProjectDetailPage from '@/features/projects/project-detail.page';
import { render, screen, waitFor } from '../../mocks/providers';
import { installRadixDomShims, makeAction, makeTask } from './helpers';

/**
 * The page-level contracts: smart default lands on the first human gate,
 * chips filter, exactly one row expands at a time, and "+ New task" creates
 * an Untitled draft that mounts in title-edit mode on the Draft stage.
 */

const hooks = vi.hoisted(() => ({
  useProject: vi.fn(),
  useUpdateProject: vi.fn(),
  useProjectTasks: vi.fn(),
  useCreateTask: vi.fn(),
  useMergeTask: vi.fn(),
  useTransitionTask: vi.fn(),
  useUpdateTask: vi.fn(),
  useDeleteTask: vi.fn(),
  useAddComment: vi.fn(),
  useCheckCriterion: vi.fn(),
  useTask: vi.fn(),
  useTaskPr: vi.fn(),
}));

vi.mock('@/features/projects/hooks/use-projects', () => hooks);
vi.mock('@/features/projects/hooks/use-attachments', () => ({
  useTaskAttachments: () => ({ data: { data: [] }, mutate: vi.fn() }),
  useUploadAttachment: () => ({ upload: vi.fn(), isUploading: false, error: null }),
  useDeleteAttachment: () => ({ remove: vi.fn(), isDeleting: false }),
}));
// The inline header pulls the GitHub surface + auth — mock at the seams.
vi.mock('@/shared/github/use-github', () => ({
  useGithubStatus: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('@/shared/auth/auth-context', () => ({
  useAuth: () => ({ user: { orgId: 'o' } }),
}));

const project = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: 'o',
  name: 'Fixture project',
  context: null,
  repoUrl: null,
  githubRepoId: null,
  githubRepoFullName: null,
  defaultBranch: 'main',
  workdir: null,
  mode: 'manual' as const,
  maxParallel: null,
  autoPausedAt: null,
  createdBy: 'u',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function renderPage() {
  return render(
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
    </Routes>,
    { initialEntries: [`/projects/${project.id}`] },
  );
}

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  hooks.useProject.mockReturnValue({ data: project, isLoading: false });
  hooks.useUpdateProject.mockReturnValue(makeAction());
  hooks.useCreateTask.mockReturnValue(makeAction());
  hooks.useMergeTask.mockReturnValue(makeAction());
  hooks.useTransitionTask.mockReturnValue(makeAction());
  hooks.useUpdateTask.mockReturnValue(makeAction());
  hooks.useDeleteTask.mockReturnValue(makeAction());
  hooks.useAddComment.mockReturnValue(makeAction());
  hooks.useCheckCriterion.mockReturnValue(makeAction());
  hooks.useTask.mockReturnValue({ data: undefined });
  hooks.useTaskPr.mockReturnValue({ data: undefined, isLoading: false });
});

describe('ProjectDetailPage', () => {
  it('lands on the first human gate and filters the list to it', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', status: 'ready', title: 'Ready one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', status: 'needs_review', title: 'Review me' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000003', status: 'done', title: 'Done one' }),
        ],
      },
    });
    renderPage();

    expect(
      screen.getByRole('button', { name: /tasks\.status\.needs_review1/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Review me')).toBeInTheDocument();
    expect(screen.queryByText('Ready one')).not.toBeInTheDocument();
  });

  it('shows the dispatch-paused banner at the merge-debt cap', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [1, 2, 3].map((n) =>
          makeTask({
            id: `11111111-0000-4000-8000-00000000000${n}`,
            status: 'approved',
            ciState: 'passing',
            title: `Approved ${n}`,
          }),
        ),
      },
    });
    renderPage();

    expect(screen.getByText('tasks.v2.dispatchPaused')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /tasks\.actions\.mergeAllGreen/ }),
    ).toBeInTheDocument();
  });

  it('expands one row at a time', async () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', status: 'done', title: 'Row A' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', status: 'done', title: 'Row B' }),
        ],
      },
    });
    renderPage();

    await userEvent.click(screen.getByText('Row A'));
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);

    await userEvent.click(screen.getByText('Row B'));
    const expanded = screen.getAllByRole('button', { expanded: true });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toHaveAccessibleName('Row B');
  });

  it('"+ New task" creates an Untitled draft and lands on it in title-edit mode', async () => {
    const created = makeTask({
      id: '11111111-0000-4000-8000-00000000fresh'.replace('fresh', '0009'),
      status: 'draft',
      title: 'tasks.v2.untitled',
      context: null,
      acceptanceCriteria: [],
    });
    // Like production: the row does not exist until create resolves and the
    // list revalidates — it must MOUNT fresh to arm title-edit mode.
    const list = {
      current: [
        makeTask({ id: '11111111-0000-4000-8000-000000000001', status: 'done', title: 'Old' }),
      ],
    };
    hooks.useProjectTasks.mockImplementation(() => ({
      isLoading: false,
      data: { data: list.current },
    }));
    const create = makeAction(
      vi.fn().mockImplementation(async () => {
        list.current = [created, ...list.current];
        return { e: null, d: created };
      }),
    );
    hooks.useCreateTask.mockReturnValue(create);
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /tasks\.newTask/ }));

    expect(create.execute).toHaveBeenCalledWith({
      projectId: project.id,
      title: 'tasks.v2.untitled',
    });
    // Draft stage selected, and the fresh row's title is an editable input.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /tasks\.status\.draft1/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.getByDisplayValue('tasks.v2.untitled')).toBeInTheDocument();
  });
});
