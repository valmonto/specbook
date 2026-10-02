import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ServerTerminalDialog } from '@/shared/servers/server-terminal-dialog';
import { render, screen, waitFor } from '../../mocks/providers';
import { installRadixDomShims } from '../projects/helpers';

/**
 * Esc is the terminal's key, not the dialog's.
 *
 * Radix closes a dialog on Escape by default, and its dismissable layer sees
 * the keydown before xterm does — so the default left the operator unable to
 * leave vim's insert mode, cancel a readline edit, or back out of a TUI, and
 * killed the shell instead. Closing by the × button still has to work, or the
 * fix would just trap people in the dialog.
 */

const openShell = vi.fn();
vi.mock('@/shared/servers/api', () => ({
  serversApi: { openShell: (...args: unknown[]) => openShell(...args) },
}));

/** xterm drives a real canvas; jsdom has none, so stand in for the whole terminal. */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

function renderDialog() {
  const onOpenChange = vi.fn();
  render(
    <ServerTerminalDialog
      serverId="11111111-1111-4111-8111-111111111111"
      serverName="box-1"
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { onOpenChange };
}

describe('ServerTerminalDialog dismissal', () => {
  beforeEach(() => {
    installRadixDomShims();
    // ResizeObserver already comes from the shared test setup.
    vi.stubGlobal('WebSocket', FakeWebSocket);
    openShell.mockResolvedValue({
      ticket: 'ticket-1',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    openShell.mockReset();
  });

  it('keeps the dialog open when Esc is pressed, so the key reaches the shell', async () => {
    const { onOpenChange } = renderDialog();
    await waitFor(() => expect(openShell).toHaveBeenCalled());

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('server-terminal')).toBeInTheDocument();
  });

  /** Without a working × the fix would trade one bug for a worse one. */
  it('still closes from the dialog’s own close button', async () => {
    const { onOpenChange } = renderDialog();
    await waitFor(() => expect(openShell).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
