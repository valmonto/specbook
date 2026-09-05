import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { Environment } from '@pkg/contracts';
import {
  formatRemaining,
  McpAccessChip,
  McpAccessPanel,
} from '@/features/projects/components/mcp-access-panel';
import { render, screen, within } from '../../mocks/providers';
import { installRadixDomShims, makeAction } from './helpers';

/**
 * Strings are translation KEYS (mocks/i18n.ts returns the key). The panel is
 * the human side of default-denied agent data access: a closed door shows
 * the open action, an open window shows a live countdown + revoke, and the
 * PRODUCTION dialog cannot submit until a reason is given and the name typed.
 */

const hooks = vi.hoisted(() => ({
  useGrantMcpAccess: vi.fn(),
  useRevokeMcpAccess: vi.fn(),
  useAccessAudit: vi.fn(),
}));
vi.mock('@/features/projects/hooks/use-environments', () => hooks);

const PROJECT = '22222222-2222-4222-8222-222222222222';

const env = (overrides: Partial<Environment> = {}): Environment => ({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: PROJECT,
  name: 'staging',
  serverId: '33333333-3333-4333-8333-333333333333',
  serverName: 'box',
  databaseServerId: null,
  databaseServerName: null,
  cacheServerId: null,
  cacheServerName: null,
  storageServerId: null,
  storageServerName: null,
  dataTransport: null,
  domain: null,
  deployPath: null,
  autoDeploy: false,
  platformEnv: {},
  userEnvNames: [],
  userEnvVars: [],
  provisionStatus: 'provisioned',
  provisionError: null,
  provisionedAt: null,
  latestDeployment: null,
  autoDeployPaused: false,
  domainPending: false,
  publicUrl: null,
  mcpAccess: 'none',
  mcpAccessUntil: null,
  mcpAccessBy: null,
  mcpAccessByName: null,
  mcpAccessReason: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

let grant: ReturnType<typeof makeAction>;
let revoke: ReturnType<typeof makeAction>;

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  grant = makeAction();
  revoke = makeAction();
  hooks.useGrantMcpAccess.mockReturnValue(grant);
  hooks.useRevokeMcpAccess.mockReturnValue(revoke);
  hooks.useAccessAudit.mockReturnValue({ data: null, isLoading: false });
});

describe('formatRemaining', () => {
  it('counts down mm:ss, then h mm', () => {
    const now = new Date('2026-09-05T12:00:00Z').getTime();
    expect(formatRemaining('2026-09-05T12:12:34Z', now)).toBe('12:34');
    expect(formatRemaining('2026-09-05T13:02:00Z', now)).toBe('1h 02m');
    expect(formatRemaining('2026-09-05T11:00:00Z', now)).toBe('00:00');
  });
});

describe('McpAccessPanel — closed door', () => {
  it('shows the closed state and the open action for managers; no chip in the header', () => {
    render(
      <>
        <McpAccessChip env={env()} />
        <McpAccessPanel env={env()} projectId={PROJECT} canManage />
      </>,
    );
    const state = screen.getByTestId('mcp-access-state');
    expect(within(state).getByText('environments.mcpAccess.closed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /environments.mcpAccess.openAction/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/environments.mcpAccess.openRead/)).not.toBeInTheDocument();
  });

  it('a reader sees the state but no controls', () => {
    render(<McpAccessPanel env={env()} projectId={PROJECT} canManage={false} />);
    expect(screen.queryByRole('button', { name: /environments.mcpAccess.openAction/ })).toBeNull();
  });

  it('staging: the dialog submits a read window with the chosen minutes and reason', async () => {
    const user = userEvent.setup();
    render(<McpAccessPanel env={env()} projectId={PROJECT} canManage />);
    await user.click(screen.getByRole('button', { name: /environments.mcpAccess.openAction/ }));
    const dialog = await screen.findByRole('dialog');
    // No production warning, no confirm field on staging.
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).queryByLabelText(/confirmLabel/)).toBeNull();
    const minutes = within(dialog).getByLabelText('environments.mcpAccess.minutes');
    await user.clear(minutes);
    await user.type(minutes, '45');
    await user.type(within(dialog).getByLabelText('environments.mcpAccess.reason'), 'stuck job');
    await user.click(
      within(dialog).getByRole('button', { name: 'environments.mcpAccess.openAction' }),
    );
    expect(grant.execute).toHaveBeenCalledWith({
      projectId: PROJECT,
      id: env().id,
      mode: 'read',
      minutes: 45,
      reason: 'stuck job',
      confirm: undefined,
    });
  });

  it('a window longer than the environment allows cannot be submitted', async () => {
    const user = userEvent.setup();
    render(<McpAccessPanel env={env()} projectId={PROJECT} canManage />);
    await user.click(screen.getByRole('button', { name: /environments.mcpAccess.openAction/ }));
    const dialog = await screen.findByRole('dialog');
    const minutes = within(dialog).getByLabelText('environments.mcpAccess.minutes');
    await user.clear(minutes);
    await user.type(minutes, '241');
    expect(
      within(dialog).getByRole('button', { name: 'environments.mcpAccess.openAction' }),
    ).toBeDisabled();
  });
});

describe('McpAccessPanel — production is the louder door', () => {
  it('warns, requires a reason AND the typed name, and caps at 30 minutes', async () => {
    const user = userEvent.setup();
    render(<McpAccessPanel env={env({ name: 'production' })} projectId={PROJECT} canManage />);
    await user.click(screen.getByRole('button', { name: /environments.mcpAccess.openAction/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'environments.mcpAccess.productionWarning',
    );
    const submit = within(dialog).getByRole('button', {
      name: 'environments.mcpAccess.openAction',
    });
    // Default 15 minutes, but nothing typed yet → disabled.
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('environments.mcpAccess.reason'), 'incident 42');
    expect(submit).toBeDisabled();
    const confirm = within(dialog).getByLabelText('environments.mcpAccess.confirmLabel');
    await user.type(confirm, 'staging');
    expect(submit).toBeDisabled();
    await user.clear(confirm);
    await user.type(confirm, 'production');
    expect(submit).toBeEnabled();
    // Over the production ceiling → disabled again.
    const minutes = within(dialog).getByLabelText('environments.mcpAccess.minutes');
    await user.clear(minutes);
    await user.type(minutes, '31');
    expect(submit).toBeDisabled();
    await user.clear(minutes);
    await user.type(minutes, '30');
    await user.click(submit);
    expect(grant.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'read',
        minutes: 30,
        reason: 'incident 42',
        confirm: 'production',
      }),
    );
  });
});

describe('McpAccessPanel — open window', () => {
  const openEnv = () =>
    env({
      mcpAccess: 'read',
      mcpAccessUntil: new Date(Date.now() + 12 * 60_000 + 34_000).toISOString(),
      mcpAccessBy: 'u1',
      mcpAccessByName: 'Lukas',
      mcpAccessReason: 'checking the queue',
    });

  it('shows who opened it, the reason, a countdown, the header chip, and revoke-now', async () => {
    const user = userEvent.setup();
    render(
      <>
        <McpAccessChip env={openEnv()} />
        <McpAccessPanel env={openEnv()} projectId={PROJECT} canManage />
      </>,
    );
    expect(screen.getAllByText(/environments.mcpAccess.openRead/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('mcp-access-countdown')).toHaveTextContent(
      'environments.mcpAccess.remaining',
    );
    expect(screen.getByText(/checking the queue/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /environments.mcpAccess.openAction/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /environments.mcpAccess.revoke/ }));
    expect(revoke.execute).toHaveBeenCalledWith({ projectId: PROJECT, id: env().id });
  });

  it('the audit list is fetched only when expanded and renders outcomes', async () => {
    const user = userEvent.setup();
    hooks.useAccessAudit.mockImplementation((_p: string, id: string | null) => ({
      data: id
        ? {
            data: [
              {
                id: 'a1',
                environmentId: env().id,
                projectName: 'p',
                environmentName: 'staging',
                apiKeyId: 'k',
                agentName: 'runner-a',
                userId: null,
                userName: null,
                taskId: null,
                resource: 'database',
                operation: 'sql',
                target: 'SELECT 1',
                outcome: 'allowed',
                detail: null,
                durationMs: 12,
                createdAt: '2026-09-05T12:00:00.000Z',
              },
            ],
          }
        : null,
      isLoading: false,
    }));
    render(<McpAccessPanel env={openEnv()} projectId={PROJECT} canManage />);
    expect(hooks.useAccessAudit).toHaveBeenLastCalledWith(PROJECT, null);
    await user.click(screen.getByRole('button', { name: /environments.mcpAccess.auditShow/ }));
    expect(hooks.useAccessAudit).toHaveBeenLastCalledWith(PROJECT, env().id);
    expect(screen.getByText('runner-a')).toBeInTheDocument();
    expect(screen.getByText('environments.mcpAccess.outcome.allowed')).toBeInTheDocument();
    expect(screen.getByText('SELECT 1')).toBeInTheDocument();
  });
});
