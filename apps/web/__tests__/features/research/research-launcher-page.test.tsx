import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import type { Research } from '@pkg/contracts';
import ResearchPage from '@/features/research/research.page';
import { render, screen, waitFor } from '../../mocks/providers';
import { makeAction } from '../projects/helpers';

/**
 * The launcher contracts: the composer starts a new research seeded with the
 * typed message and navigates into it; the Recent strip lists documents; and
 * "Search all research" pages the keyset feed forever.
 */

const hooks = vi.hoisted(() => ({
  useCreateResearch: vi.fn(),
  useRecentResearch: vi.fn(),
  useResearchSearch: vi.fn(),
}));

vi.mock('@/features/research/hooks/use-research', () => hooks);
vi.mock('@/shared/hooks/use-permissions', () => ({ useCan: () => true }));

function makeResearch(overrides: Partial<Research> = {}): Research {
  return {
    id: 'r1',
    orgId: 'o',
    projectId: null,
    title: 'Backups & restore strategy',
    status: 'needs_review',
    bodyMarkdown: null,
    version: 0,
    createdBy: 'u',
    acceptedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <Routes>
      <Route path="/research" element={<ResearchPage />} />
      <Route path="/research/:researchId" element={<div>DETAIL-STUB</div>} />
    </Routes>,
    { initialEntries: ['/research'] },
  );
}

beforeEach(() => {
  hooks.useCreateResearch.mockReturnValue(makeAction());
  hooks.useRecentResearch.mockReturnValue({
    data: { data: [makeResearch()], meta: { nextCursor: null } },
    isLoading: false,
  });
  hooks.useResearchSearch.mockReturnValue({
    items: [],
    hasMore: false,
    isLoadingInitial: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
  });
});

describe('ResearchPage (launcher)', () => {
  it('lists recent research', () => {
    renderPage();
    expect(screen.getByText('Backups & restore strategy')).toBeInTheDocument();
  });

  it('starts a new research seeded with the typed message and navigates in', async () => {
    const create = makeAction(vi.fn(async () => ({ e: null, d: makeResearch({ id: 'r9' }) })));
    hooks.useCreateResearch.mockReturnValue(create);
    renderPage();

    await userEvent.type(
      screen.getByLabelText('research.launcher.heading'),
      'Compare Caddy and nginx',
    );
    await userEvent.click(screen.getByRole('button', { name: 'research.launcher.start' }));

    expect(create.execute).toHaveBeenCalledWith({
      title: 'Compare Caddy and nginx',
      message: 'Compare Caddy and nginx',
    });
    await waitFor(() => expect(screen.getByText('DETAIL-STUB')).toBeInTheDocument());
  });

  it('search all research pages the keyset feed via loadMore', async () => {
    const loadMore = vi.fn();
    hooks.useResearchSearch.mockReturnValue({
      items: [makeResearch({ id: 'r2', title: 'Edge TLS' })],
      hasMore: true,
      isLoadingInitial: false,
      isLoadingMore: false,
      loadMore,
    });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /research\.recent\.searchAll/ }));
    expect(screen.getByText('Edge TLS')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'research.search.loadingMore' }));
    expect(loadMore).toHaveBeenCalled();
  });
});
