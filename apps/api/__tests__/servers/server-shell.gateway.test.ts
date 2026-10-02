import { EventEmitter } from 'node:events';
import {
  SHELL_SESSION_IDLE_MS,
  SHELL_SESSION_MAX_TOTAL_MS,
  SHELL_SESSION_RENEW_WITHIN_MS,
  SHELL_SESSION_TTL_MS,
} from '@pkg/contracts';
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

/** The window a freshly issued session gets, as the service stamps it. */
const EXPIRES_IN_MS = SHELL_SESSION_TTL_MS;

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
    extendExpiry: vi.fn().mockResolvedValue(true),
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
  } as unknown as ServerShellRepository & { extendExpiry: ReturnType<typeof vi.fn> };

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

  const socket = fakeSocket();
  return {
    gateway,
    shells,
    repo,
    socket,
    /** The absolute deadline no amount of renewing may cross. */
    ceiling: claim.expiresAt.getTime() - SHELL_SESSION_TTL_MS + SHELL_SESSION_MAX_TOTAL_MS,
    emitOutput: (text: string) => onData?.(Buffer.from(text)),
    /** A keystroke, as the browser sends one: a binary frame. */
    type: (text = 'x') => socket.emit('message', Buffer.from(text), true),
  };
}

/**
 * Advance the clock while the far end keeps talking.
 *
 * The idle window is shorter than the session window, so a session simply left
 * alone is reaped long before it could ever reach the renewal zone. Reaching it
 * without typing is what a real long-running command does: it prints, which
 * defeats the idle reaper but — deliberately — does not renew the session.
 */
async function waitWhileBusy(h: ReturnType<typeof harness>, ms: number): Promise<void> {
  const step = Math.floor(SHELL_SESSION_IDLE_MS / 2);
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    h.emitOutput('.');
  }
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
    h.type('ls\n');
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_IDLE_MS - 1_000);

    expect(outcomes(h.shells)).not.toContain('idle');
  });
});

/**
 * The window is renewable while the operator is demonstrably present, up to an
 * absolute ceiling. The thing being guarded against is a FORGOTTEN terminal,
 * so a wall that kills a session mid-keystroke punishes the wrong case — but
 * the ceiling, and the fact that only keystrokes renew, are what keep the
 * control real rather than decorative.
 */
describe('ServerShellGateway window renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Typing near the end of the window pushes it out. */
  it('renews the window when the operator types inside the renewal zone', async () => {
    const h = harness();
    await connect(h);

    await waitWhileBusy(h, SHELL_SESSION_TTL_MS - SHELL_SESSION_RENEW_WITHIN_MS + 1_000);
    h.type();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.repo.extendExpiry).toHaveBeenCalledTimes(1);
    const [args] = h.repo.extendExpiry.mock.calls[0] as [
      { sessionId: string; orgId: string; expiresAt: Date },
    ];
    expect(args.sessionId).toBe('session-1');
    // Org-scoped like every other write here: a renewal is only applied to a
    // session belonging to the renewing org.
    expect(args.orgId).toBe('org1');
    expect(args.expiresAt.getTime()).toBe(Date.now() + SHELL_SESSION_TTL_MS);
  });

  /** One row update per renewal, not one per character. */
  it('does not write a row for every keystroke', async () => {
    const h = harness();
    await connect(h);

    await vi.advanceTimersByTimeAsync(60_000);
    for (const ch of 'a long command line') h.type(ch);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.repo.extendExpiry).not.toHaveBeenCalled();
  });

  /**
   * Output must never renew. A `tail -f` left running would otherwise hold the
   * window open indefinitely with nobody there — the exact thing the expiry is
   * for.
   */
  it('is not renewed by output from the remote end', async () => {
    const h = harness();
    await connect(h);

    await waitWhileBusy(h, SHELL_SESSION_TTL_MS - SHELL_SESSION_RENEW_WITHIN_MS + 1_000);
    h.emitOutput('…still building\n');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.repo.extendExpiry).not.toHaveBeenCalled();
  });

  /** The countdown must not run down to a deadline that has already moved. */
  it('tells the browser the new deadline', async () => {
    const h = harness();
    await connect(h);

    await waitWhileBusy(h, SHELL_SESSION_TTL_MS - SHELL_SESSION_RENEW_WITHIN_MS + 1_000);
    h.type();
    await vi.advanceTimersByTimeAsync(0);

    const sent = h.socket.send.mock.calls.map(([frame]) => String(frame));
    const expiry = sent.find((frame) => frame.includes('"type":"expiry"'));
    expect(expiry).toBeDefined();
    expect(new Date(JSON.parse(expiry!).expiresAt).getTime()).toBe(
      Date.now() + SHELL_SESSION_TTL_MS,
    );
  });

  /** The row is the record: if it did not move, neither does the deadline. */
  it('keeps the old deadline when the row refuses to move', async () => {
    const h = harness();
    h.repo.extendExpiry.mockResolvedValue(false);
    await connect(h);

    await waitWhileBusy(h, SHELL_SESSION_TTL_MS - SHELL_SESSION_RENEW_WITHIN_MS + 1_000);
    h.type();
    await vi.advanceTimersByTimeAsync(SHELL_SESSION_RENEW_WITHIN_MS);

    expect(outcomes(h.shells)).toContain('expired');
  });

  /**
   * The ceiling is what makes this a renewal rather than an abolition: past it
   * the session ends however busy the operator is.
   */
  it('stops renewing at the absolute ceiling and ends the session', async () => {
    const h = harness();
    await connect(h);

    // Type continuously, well past the ceiling.
    for (let elapsed = 0; elapsed < SHELL_SESSION_MAX_TOTAL_MS + SHELL_SESSION_TTL_MS;) {
      await vi.advanceTimersByTimeAsync(60_000);
      elapsed += 60_000;
      h.type();
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(outcomes(h.shells)).toContain('expired');
    // Every renewal it ever granted stayed inside the ceiling.
    for (const [args] of h.repo.extendExpiry.mock.calls as [{ expiresAt: Date }][]) {
      expect(args.expiresAt.getTime()).toBeLessThanOrEqual(h.ceiling);
    }
  });
});
