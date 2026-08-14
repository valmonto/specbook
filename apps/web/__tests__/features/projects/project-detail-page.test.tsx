import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import ProjectDetailPage from '@/features/projects/project-detail.page';
import { render, screen, waitFor } from '../../mocks/providers';
import { installRadixDomShims, makeAction, makeTask } from './helpers';

/**
 * The page-level contracts after the status controls were consolidated: the
 * board ALWAYS groups by area, the pipeline strip is the single status filter
 * over it, the title search is orthogonal, and the merge-debt gate counts the
 * full set regardless of the view filter. "+ New task" creates an Untitled
 * draft that mounts in title-edit mode.
 *
 * The board defaults to the Draft stage: with no `?stage` the view opens on
 * Draft. Show-all is reachable through the explicit `?stage=all` sentinel —
 * deselecting the Draft chip lands there, never back on the Draft default. The
 * older "all stages" fixtures below therefore open at `?stage=all` explicitly.
 */

const hooks = vi.hoisted(() => ({
  useProject: vi.fn(),
  useUpdateProject: vi.fn(),
  useProjectTasks: vi.fn(),
  useCreateTask: vi.fn(),
  useMergeTask: vi.fn(),
  useTransitionTask: vi.fn(),
  useMarkReady: vi.fn(),
  useUpdateTask: vi.fn(),
  useDeleteTask: vi.fn(),
  useAddComment: vi.fn(),
  useCheckCriterion: vi.fn(),
  useTask: vi.fn(),
  useTaskPr: vi.fn(),
  useUnarchiveProject: vi.fn(),
  useResumeProject: vi.fn(),
  // The expanded row mounts the shared <TaskDetail>, which reads these.
  useProjectAreas: vi.fn(),
  useAddDependency: vi.fn(),
  useRemoveDependency: vi.fn(),
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
vi.mock('@/shared/hooks/use-permissions', () => ({
  useCan: () => true,
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

// The board always groups by area; ?stage= filters it and ?q= searches titles.
function renderPage(search = '') {
  return render(
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
    </Routes>,
    { initialEntries: [`/projects/${project.id}${search}`] },
  );
}

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  hooks.useProject.mockReturnValue({ data: project, isLoading: false });
  hooks.useUpdateProject.mockReturnValue(makeAction());
  hooks.useResumeProject.mockReturnValue(makeAction());
  hooks.useCreateTask.mockReturnValue(makeAction());
  hooks.useMergeTask.mockReturnValue(makeAction());
  hooks.useTransitionTask.mockReturnValue(makeAction());
  hooks.useMarkReady.mockReturnValue(makeAction());
  hooks.useUpdateTask.mockReturnValue(makeAction());
  hooks.useDeleteTask.mockReturnValue(makeAction());
  hooks.useAddComment.mockReturnValue(makeAction());
  hooks.useCheckCriterion.mockReturnValue(makeAction());
  hooks.useTask.mockReturnValue({ data: undefined });
  hooks.useTaskPr.mockReturnValue({ data: undefined, isLoading: false });
  hooks.useUnarchiveProject.mockReturnValue(makeAction());
  hooks.useProjectAreas.mockReturnValue({ data: { areas: [] } });
  hooks.useAddDependency.mockReturnValue(makeAction());
  hooks.useRemoveDependency.mockReturnValue(makeAction());
});

describe('ProjectDetailPage', () => {
  it('defaults to the Draft stage when the URL has no ?stage', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'draft', title: 'Draft one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Done one' }),
        ],
      },
    });
    renderPage();

    // Fresh open lands on Draft: the chip is pressed and the board shows only
    // draft tasks — the other stages are filtered out.
    expect(screen.getByRole('button', { name: /tasks\.status\.draft/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Draft one')).toBeInTheDocument();
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
  });

  it('?stage=all is the reachable show-all: every stage shows, no chip pressed', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'draft', title: 'Draft one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Done one' }),
        ],
      },
    });
    renderPage('?stage=all');

    // The all sentinel hides nothing and presses no chip — not even Draft.
    expect(screen.getByRole('button', { name: /tasks\.status\.draft/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('Draft one')).toBeInTheDocument();
    expect(screen.getByText('Done one')).toBeInTheDocument();
  });

  it('deselecting the Draft chip lands on show-all, not back on the default', async () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'draft', title: 'Draft one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Done one' }),
        ],
      },
    });
    renderPage();

    // Default: Draft selected, non-draft hidden.
    expect(screen.getByRole('button', { name: /tasks\.status\.draft/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();

    // Click the active Draft chip → deselect → show-all (all stages), which
    // must NOT snap back to the Draft default.
    await userEvent.click(screen.getByRole('button', { name: /tasks\.status\.draft/ }));

    expect(screen.getByRole('button', { name: /tasks\.status\.draft/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('Draft one')).toBeInTheDocument();
    expect(screen.getByText('Done one')).toBeInTheDocument();
  });

  it('always groups the board by area and has no group-by toggle', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', title: 'Bill one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: null, title: 'Untagged one' }),
        ],
      },
    });
    // Open at show-all so the grouping (not the Draft default) is under test.
    renderPage('?stage=all');

    // The consolidated board dropped the Group by: Status | Area control.
    expect(screen.queryByRole('button', { name: 'tasks.groupByStatus' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'tasks.groupByArea' })).not.toBeInTheDocument();

    // Section headers: the named area and the untagged bucket, rows visible.
    // ("Billing" appears twice — section header + the row's area chip.)
    expect(screen.getAllByText('Billing').length).toBeGreaterThan(0);
    expect(screen.getByText('tasks.noArea')).toBeInTheDocument();
    expect(screen.getByText('Bill one')).toBeInTheDocument();
    expect(screen.getByText('Untagged one')).toBeInTheDocument();

    // The strip renders as the status filter with nothing selected (all stages).
    expect(screen.getByRole('button', { name: /tasks\.status\.draft/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking a stage in the strip filters the area board to it', async () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'in_progress', title: 'Live one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Done one' }),
        ],
      },
    });
    renderPage('?stage=all');

    // All stages: both rows show.
    expect(screen.getByText('Live one')).toBeInTheDocument();
    expect(screen.getByText('Done one')).toBeInTheDocument();

    // Filter to Done via the strip — the board narrows, the chip presses.
    await userEvent.click(screen.getByRole('button', { name: /tasks\.status\.done/ }));

    expect(screen.getByRole('button', { name: /tasks\.status\.done/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Done one')).toBeInTheDocument();
    expect(screen.queryByText('Live one')).not.toBeInTheDocument();

    // Clicking the selected stage again clears back to all stages.
    await userEvent.click(screen.getByRole('button', { name: /tasks\.status\.done/ }));
    expect(screen.getByRole('button', { name: /tasks\.status\.done/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('Live one')).toBeInTheDocument();
  });

  it('restores the stage filter from ?stage= (shareable link)', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'in_progress', title: 'Live one' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Done one' }),
        ],
      },
    });
    renderPage('?stage=done');

    expect(screen.getByRole('button', { name: /tasks\.status\.done/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Done one')).toBeInTheDocument();
    expect(screen.queryByText('Live one')).not.toBeInTheDocument();
  });

  it('area section rollups reflect the active stage filter, not the full list', () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'done', title: 'Done A' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Done B' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000003', area: 'Billing', status: 'in_progress', title: 'Live C' }),
        ],
      },
    });
    // Filter to in_progress: the Billing rollup should show only the 1 live task
    // — no "done: 2" segment survives the filter.
    renderPage('?stage=in_progress');

    expect(screen.getByText('Live C')).toBeInTheDocument();
    expect(screen.queryByText('Done A')).not.toBeInTheDocument();
    expect(screen.getByTitle('tasks.status.in_progress: 1')).toBeInTheDocument();
    expect(screen.queryByTitle('tasks.status.done: 2')).not.toBeInTheDocument();
  });

  it('the title search narrows the board and lives in the URL (?q=)', async () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'in_progress', title: 'Keepme alpha' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Dropme beta' }),
        ],
      },
    });
    // Restored from the URL: only the matching row survives, the box shows it.
    // At show-all so the search (not the Draft default) is what narrows.
    renderPage('?stage=all&q=keepme');

    expect(screen.getByText('Keepme alpha')).toBeInTheDocument();
    expect(screen.queryByText('Dropme beta')).not.toBeInTheDocument();
    expect(screen.getByLabelText('tasks.filter.searchLabel')).toHaveValue('keepme');

    // Typing is wired: narrowing further hides the last match too.
    await userEvent.type(screen.getByLabelText('tasks.filter.searchLabel'), ' zzz');
    expect(screen.queryByText('Keepme alpha')).not.toBeInTheDocument();
  });

  it('the merge-debt gate counts the FULL set even when a filter hides it', () => {
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
    // Filter to a stage with zero tasks: the board is empty, yet the pause is a
    // project fact — the banner and merge action must still show.
    renderPage('?stage=draft');

    expect(screen.queryByText('Approved 1')).not.toBeInTheDocument();
    expect(screen.getByText('tasks.v2.dispatchPaused')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /tasks\.actions\.mergeAllGreen/ }),
    ).toBeInTheDocument();
  });

  it('expands one row at a time within the area board', async () => {
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: {
        data: [
          makeTask({ id: '11111111-0000-4000-8000-000000000001', area: 'Billing', status: 'done', title: 'Row A' }),
          makeTask({ id: '11111111-0000-4000-8000-000000000002', area: 'Billing', status: 'done', title: 'Row B' }),
        ],
      },
    });
    renderPage('?stage=all');

    // The chevron toggle carries the title as its accessible name AND
    // aria-expanded (section headers name their area, not a title), so the
    // expanded filter pins the one open row.
    await userEvent.click(screen.getByText('Row A'));
    expect(screen.getByRole('button', { name: 'Row A', expanded: true })).toBeInTheDocument();

    await userEvent.click(screen.getByText('Row B'));
    expect(screen.getByRole('button', { name: 'Row B', expanded: true })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Row A', expanded: true }),
    ).not.toBeInTheDocument();
  });

  it('an archived project renders the read-only banner and hides "+ New task"', () => {
    hooks.useProject.mockReturnValue({
      data: { ...project, archivedAt: '2026-08-02T00:00:00.000Z' },
      isLoading: false,
    });
    hooks.useProjectTasks.mockReturnValue({
      isLoading: false,
      data: { data: [makeTask({ id: '11111111-0000-4000-8000-000000000001', status: 'done', title: 'Row A' })] },
    });
    renderPage();

    expect(screen.getByText('tasks.archivedBanner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tasks\.unarchiveProject/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tasks\.newTask/ })).not.toBeInTheDocument();
  });

  it('"+ New task" creates an Untitled draft and lands on it in title-edit mode', async () => {
    const created = makeTask({
      id: '11111111-0000-4000-8000-000000000009',
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

    await userEvent.click(screen.getByRole('button', { name: 'tasks.newTask' }));

    expect(create.execute).toHaveBeenCalledWith({
      projectId: project.id,
      title: 'tasks.v2.untitled',
    });
    // The fresh row mounts with its title as an editable input.
    await waitFor(() =>
      expect(screen.getByDisplayValue('tasks.v2.untitled')).toBeInTheDocument(),
    );
  });
});
