import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import ProjectsPage from '@/features/projects/projects.page';
import { render, screen, waitFor } from '../../mocks/providers';
import { installRadixDomShims, makeAction } from './helpers';

/**
 * The archive surface on the projects list: the card cog opens a confirmed
 * archive, archived projects render in their own section with unarchive,
 * and a viewer without project:delete sees neither control.
 */

const hooks = vi.hoisted(() => ({
  useProjects: vi.fn(),
  useArchiveProject: vi.fn(),
  useUnarchiveProject: vi.fn(),
  useDeleteProject: vi.fn(),
}));
const permissions = vi.hoisted(() => ({ can: true }));

vi.mock('@/features/projects/hooks/use-projects', () => hooks);
vi.mock('@/shared/hooks/use-permissions', () => ({
  useCan: () => permissions.can,
}));

const project = (id: string, name: string) => ({
  id,
  orgId: 'o',
  name,
  context: null,
  repoUrl: null,
  githubRepoId: null,
  githubRepoFullName: null,
  defaultBranch: 'main',
  workdir: null,
  mode: 'manual' as const,
  maxParallel: null,
  autoPausedAt: null,
  archivedAt: null,
  createdBy: 'u',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  statusCounts: {},
});

function renderPage() {
  return render(
    <Routes>
      <Route path="/projects" element={<ProjectsPage />} />
    </Routes>,
    { initialEntries: ['/projects'] },
  );
}

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  permissions.can = true;
  // First call = live list, second call = archived list.
  hooks.useProjects.mockImplementation((archived?: boolean) => ({
    canList: true,
    isLoading: false,
    data: {
      data: archived
        ? [
            {
              ...project('aaaaaaaa-0000-4000-8000-000000000002', 'Old thing'),
              archivedAt: '2026-08-01T00:00:00.000Z',
            },
          ]
        : [project('aaaaaaaa-0000-4000-8000-000000000001', 'Live thing')],
    },
  }));
  hooks.useArchiveProject.mockReturnValue(makeAction());
  hooks.useUnarchiveProject.mockReturnValue(makeAction());
  hooks.useDeleteProject.mockReturnValue(makeAction());
});

describe('ProjectsPage — tabs, archive, delete', () => {
  it('archives through the cog only after the confirm dialog', async () => {
    const archive = makeAction();
    hooks.useArchiveProject.mockReturnValue(archive);
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'tasks.archiveProject' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /tasks\.archiveProject/ }));
    expect(screen.getByText('tasks.archiveConfirmTitle')).toBeInTheDocument();
    expect(archive.execute).not.toHaveBeenCalled();

    await userEvent.click(screen.getAllByRole('button', { name: /tasks\.archiveProject/ }).at(-1)!);
    await waitFor(() =>
      expect(archive.execute).toHaveBeenCalledWith({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    );
  });

  it('the Archived tab lists archived projects; unarchive and delete both need the confirm', async () => {
    const unarchive = makeAction();
    const remove = makeAction();
    hooks.useUnarchiveProject.mockReturnValue(unarchive);
    hooks.useDeleteProject.mockReturnValue(remove);
    renderPage();

    await userEvent.click(screen.getByRole('tab', { name: /tasks\.archivedProjects/ }));
    expect(screen.getByText('Old thing')).toBeInTheDocument();

    // Unarchive: gated by its confirm dialog too.
    await userEvent.click(screen.getByRole('button', { name: 'tasks.unarchiveProject' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /tasks\.unarchiveProject/ }));
    await screen.findByText('tasks.unarchiveConfirmTitle');
    expect(unarchive.execute).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getAllByRole('button', { name: /tasks\.unarchiveProject/ }).at(-1)!,
    );
    await waitFor(() =>
      expect(unarchive.execute).toHaveBeenCalledWith({
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
      }),
    );

    // Delete: destructive, gated by the confirm dialog.
    await userEvent.click(screen.getByRole('button', { name: 'tasks.unarchiveProject' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /tasks\.deleteProject/ }));
    expect(screen.getByText('tasks.deleteConfirmTitle')).toBeInTheDocument();
    expect(remove.execute).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: /tasks\.deleteProject/ }).at(-1)!);
    await waitFor(() =>
      expect(remove.execute).toHaveBeenCalledWith({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
    );
  });

  it('without project:delete there is no cog anywhere', async () => {
    permissions.can = false;
    renderPage();

    expect(screen.queryByRole('button', { name: 'tasks.archiveProject' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /tasks\.archivedProjects/ }));
    expect(
      screen.queryByRole('button', { name: 'tasks.unarchiveProject' }),
    ).not.toBeInTheDocument();
  });
});
