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
        ? [{ ...project('aaaaaaaa-0000-4000-8000-000000000002', 'Old thing'), archivedAt: '2026-08-01T00:00:00.000Z' }]
        : [project('aaaaaaaa-0000-4000-8000-000000000001', 'Live thing')],
    },
  }));
  hooks.useArchiveProject.mockReturnValue(makeAction());
  hooks.useUnarchiveProject.mockReturnValue(makeAction());
});

describe('ProjectsPage — archive', () => {
  it('archives through the cog only after the confirm dialog', async () => {
    const archive = makeAction();
    hooks.useArchiveProject.mockReturnValue(archive);
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'tasks.archiveProject' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'tasks.archiveProject' }));
    // Dialog shown, nothing executed yet.
    expect(screen.getByText('tasks.archiveConfirmTitle')).toBeInTheDocument();
    expect(archive.execute).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole('button', { name: 'tasks.archiveProject', hidden: false }),
    );
    await waitFor(() =>
      expect(archive.execute).toHaveBeenCalledWith({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    );
  });

  it('lists archived projects with an unarchive action', async () => {
    const unarchive = makeAction();
    hooks.useUnarchiveProject.mockReturnValue(unarchive);
    renderPage();

    expect(screen.getByText('tasks.archivedProjects')).toBeInTheDocument();
    expect(screen.getByText('Old thing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /tasks\.unarchiveProject/ }));
    expect(unarchive.execute).toHaveBeenCalledWith({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
  });

  it('without project:delete there is no cog and no unarchive', () => {
    permissions.can = false;
    renderPage();

    expect(screen.queryByRole('button', { name: 'tasks.archiveProject' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tasks\.unarchiveProject/ })).not.toBeInTheDocument();
  });
});
