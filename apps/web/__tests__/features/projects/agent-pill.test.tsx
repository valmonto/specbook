import { vi } from 'vitest';
import { AgentPill } from '@/features/projects/your-move.page';
import { render, screen } from '../../mocks/providers';

vi.mock('@/shared/auth/auth-context', () => ({ useAuth: () => ({ user: { orgId: 'o' } }) }));
vi.mock('@/shared/hooks/use-permissions', () => ({ useCan: () => true }));
vi.mock('@/shared/servers/server-terminal-dialog', () => ({
  ServerTerminalDialog: ({ initialCommand }: { initialCommand?: string }) => (
    <div data-testid="terminal">{initialCommand}</div>
  ),
}));

const base = {
  id: '0195f2a1-0000-7000-8000-000000000001',
  name: 'spokey',
  kind: 'managed' as const,
  status: 'idle' as const,
  lastSeenAt: new Date().toISOString(),
  currentTaskId: null,
  currentTaskTitle: null,
  serverId: '0195f2a1-0000-7000-8000-000000000002',
  serverName: 'hetzner-1',
  serverHost: '46.225.170.169',
  serverSshUser: 'runner',
  log: null,
  startedAt: null,
  createdAt: new Date().toISOString(),
};

/**
 * Attaching is only meaningful while a session exists. The pill used to print
 * `ssh user@host -t tmux attach -t specbook-<name>` for the operator to copy
 * into some other terminal — while specbook had one a click away, already
 * logged in as that very user.
 */
describe('AgentPill — attach', () => {
  it('offers Attach on a running managed agent', () => {
    render(<AgentPill agent={base as never} canManage />);
    expect(screen.getByRole('button', { name: /agents\.attach/ })).toBeInTheDocument();
  });

  it('drives the terminal straight into the agent session', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(<AgentPill agent={base as never} canManage />);
    await user.click(screen.getByRole('button', { name: /agents\.attach/ }));
    expect(screen.getByTestId('terminal')).toHaveTextContent('tmux attach -t specbook-spokey');
  });

  it('does not offer it on a stopped agent — there is nothing to attach to', () => {
    render(<AgentPill agent={{ ...base, status: 'stopped' } as never} canManage />);
    expect(screen.queryByRole('button', { name: /agents\.attach/ })).not.toBeInTheDocument();
  });

  it('does not offer it on an external agent — specbook does not own its session', () => {
    render(<AgentPill agent={{ ...base, kind: 'external' } as never} canManage />);
    expect(screen.queryByRole('button', { name: /agents\.attach/ })).not.toBeInTheDocument();
  });
});
