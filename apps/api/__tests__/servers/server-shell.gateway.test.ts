import { EventEmitter } from 'node:events';
import { SHELL_SESSION_IDLE_MS } from '@pkg/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerShellGateway } from '@/servers/server-shell.gateway.js';
import type { ServerShellRepository } from '@/servers/server-shell.repository.js';
import type { ServerShellService } from '@/servers/server-shell.service.js';

/**
 * The idle reaper is the only thing standing between a forgotten tab and an
 * open shell, so it has to fire — but it also has to understand what "idle"
 * means. These drive the gateway's timer directly, because the asymmetry the
 * bug had (only the browser's keystrokes counted) is invisible to any test
 * that just checks a session can be reaped.
 */

/** Enough future that the hard expiry never fires during these tests. */
const EXPIRES_IN_MS = 60 * 60_000;

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    OPEN: number;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.send = vi.fn();
  socket.close = vi.fn();
  return socket;
}

function harness() {
  const claim = {
    sessionId: 'session-1',
    serverId: 'srv1',
    orgId: 'org1',
    userId: 'u1',
    expiresAt: new Date(Date.now() + EXPIRES_IN_MS),
  };

  const shells = {
    redeem: vi.fn().mockReturnValue(claim),
    register: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
  } as unknown as ServerShellService & { finish: ReturnType<typeof vi.fn> };

  const repo = {
    findServer: vi.fn().mockResolvedValue({
      id: 'srv1',
      name: 'build',
      host: '10.0.0.1',
      port: 22,
      sshUser: 'deploy',
      privateKeyEnc: 'enc',
      hostFingerprint: 'fp',
      orgId: 'org1',
    }),
  } as unknown as ServerShellRepository;

  /** Captured so a test can push output from the far end at will. */
  let onData: ((chunk: Buffer) => void) | undefined;
  const ssh = {
    shell: vi.fn().mockImplementation((_target, _size, handlers) => {
      onData = handlers.onData;
      return Promise.resolve({ write: vi.fn(), resize: vi.fn(), close: vi.fn() });
    }),
  };

  const secrets = { open: vi.fn().mockReturnValue('key') };
  const logger = { warn: vi.fn() };

  const gateway = new ServerShellGateway(
    shells,
    repo,
    ssh as never,
    secrets as never,
    logger as never,
  );

  return {
    gateway,
    shells,
    socket: fakeSocket(),
    emitOutput: (text: string) => onData?.(Buffer.from(text)),
  };
}

function connect(h: ReturnType<typeof harness>) {
  return h.gateway.handleConnection(
    h.socket as never,
    { url: '/api/servers/shell?ticket=t1' } as never,
  );
}

/** The outcome the gateway reports when it reaps a session. */
function outcomes(shells: { finish: ReturnType<typeof vi.fn> }): string[] {
  return shells.finish.mock.calls.map((call) => (call[0] as { outcome: string }).outcome);
}

describe('ServerShellGateway idle reaping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The regression. A build, a `tail -f`, a long migration: the far end talks
   * for many minutes while the operator types nothing. That session is the one
   * a web terminal exists for, and it used to be killed at the idle window
   * because only inbound browser messages refreshed the timer.
   */
  it('does not reap a session whose remote end is still producing output', async () => {
    const h = harness();
    await connect(h);

    // Just short of the window, then output, then just short again: with the
    // timer counting only keystrokes this lands well past the deadline.
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_IDLE_MS - 1_000);
    h.emitOutput('still building…\n');
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_IDLE_MS - 1_000);

    expect(outcomes(h.shells)).not.toContain('idle');
  });

  /** The reaper still has to work — output is activity, silence is not. */
  it('reaps a session with no traffic in either direction', async () => {
    const h = harness();
    await connect(h);

    await vi.advanceTimersByTimeAsync(SHELL_SESSION_IDLE_MS + 1_000);

    expect(outcomes(h.shells)).toContain('idle');
  });

  /** Keystrokes kept the session alive before this change, and still must. */
  it('does not reap a session the operator is typing into', async () => {
    const h = harness();
    await connect(h);

    await vi.advanceTimersByTimeAsync(SHELL_SESSION_IDLE_MS - 1_000);
    h.socket.emit('message', Buffer.from('ls\n'), true);
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_IDLE_MS - 1_000);

    expect(outcomes(h.shells)).not.toContain('idle');
  });
});
