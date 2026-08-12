import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import type { GetResearchResponse, ResearchMessage } from '@pkg/contracts';
import ResearchDetailPage from '@/features/research/research-detail.page';
import { render, screen } from '../../mocks/providers';
import { installRadixDomShims, makeAction } from '../projects/helpers';

/**
 * The detail contracts: the conversation and the living document render
 * together; a reply appends a message and shows the async researching state;
 * the document is reachable via its tab when narrow; and Create tickets files
 * DRAFT tasks through the cut-tickets endpoint.
 */

const hooks = vi.hoisted(() => ({
  useResearch: vi.fn(),
  useProjectOptions: vi.fn(),
  useResearchProjectAreas: vi.fn(),
  useAppendMessage: vi.fn(),
  useAcceptResearch: vi.fn(),
  useReopenResearch: vi.fn(),
  useUpdateResearch: vi.fn(),
  useCutTickets: vi.fn(),
}));

vi.mock('@/features/research/hooks/use-research', () => hooks);
vi.mock('@/shared/hooks/use-permissions', () => ({ useCan: () => true }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

function makeMessage(overrides: Partial<ResearchMessage> = {}): ResearchMessage {
  return {
    id: 'm1',
    researchId: 'r1',
    orgId: 'o',
    authorId: 'u',
    authorType: 'user',
    body: 'Weigh TLS renewal heavily.',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeResearch(overrides: Partial<GetResearchResponse> = {}): GetResearchResponse {
  return {
    id: 'r1',
    orgId: 'o',
    projectId: 'p1',
    title: 'Caddy vs nginx for the edge',
    status: 'needs_review',
    bodyMarkdown: '# Caddy vs nginx\n\nMove the edge to **Caddy**.',
    version: 3,
    createdBy: 'u',
    acceptedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    messages: [makeMessage()],
    tasksCut: 0,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <Routes>
      <Route path="/research/:researchId" element={<ResearchDetailPage />} />
    </Routes>,
    { initialEntries: ['/research/r1'] },
  );
}

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  hooks.useResearch.mockReturnValue({ data: makeResearch(), isLoading: false });
  hooks.useProjectOptions.mockReturnValue({ data: { data: [{ id: 'p1', name: 'SpecBook' }] } });
  hooks.useResearchProjectAreas.mockReturnValue({ data: { areas: ['Onboarding', 'Login'] } });
  hooks.useAppendMessage.mockReturnValue(makeAction());
  hooks.useAcceptResearch.mockReturnValue(makeAction());
  hooks.useReopenResearch.mockReturnValue(makeAction());
  hooks.useUpdateResearch.mockReturnValue(makeAction());
  hooks.useCutTickets.mockReturnValue(makeAction());
});

describe('ResearchDetailPage', () => {
  it('renders the conversation and the living document', () => {
    renderPage();
    // Conversation message
    expect(screen.getByText('Weigh TLS renewal heavily.')).toBeInTheDocument();
    // Document markdown heading (rendered by react-markdown)
    expect(screen.getByRole('heading', { name: 'Caddy vs nginx' })).toBeInTheDocument();
  });

  it('appends a reply and keeps the document reachable via its tab', async () => {
    // A pending append keeps the optimistic user turn on screen.
    const append = makeAction(vi.fn(() => new Promise(() => {})));
    hooks.useAppendMessage.mockReturnValue(append);
    renderPage();

    await userEvent.type(
      screen.getByLabelText('research.composer.placeholder'),
      'Verify the auto-renew claim.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'research.composer.send' }));

    expect(append.execute).toHaveBeenCalledWith({
      id: 'r1',
      body: 'Verify the auto-renew claim.',
    });
    expect(screen.getByText('Verify the auto-renew claim.')).toBeInTheDocument();

    // The Document tab exists so the artifact is never unreachable on narrow.
    const docTab = screen.getByRole('tab', { name: /research\.detail\.documentTab/ });
    await userEvent.click(docTab);
    expect(docTab).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the async researching affordance while a turn is in flight', () => {
    hooks.useResearch.mockReturnValue({
      data: makeResearch({ status: 'researching' }),
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('research.detail.researching')).toBeInTheDocument();
  });

  it('files DRAFT tasks through the cut-tickets endpoint', async () => {
    const cut = makeAction(vi.fn(async () => ({ e: null, d: { taskIds: ['t1'] } })));
    hooks.useCutTickets.mockReturnValue(cut);
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /research\.document\.createTickets/ }));

    const titleInput = await screen.findByLabelText('research.cut.titlePlaceholder');
    await userEvent.type(titleInput, 'Render a Caddyfile edge');
    await userEvent.click(screen.getByRole('button', { name: /research\.cut\.create/ }));

    expect(cut.execute).toHaveBeenCalledWith({
      id: 'r1',
      targetProjectId: 'p1',
      proposals: [{ title: 'Render a Caddyfile edge' }],
    });
  });
});
