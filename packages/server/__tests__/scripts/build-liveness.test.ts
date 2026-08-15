import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// The liveness wrapper is a plain .mjs tool in scripts/. We import its PURE core
// directly (no timers, no child processes) to prove the config + decision logic,
// and additionally drive the real CLI on short-lived commands to prove the
// start→heartbeat→end lifecycle, the hard timeout, and the reason→exit-code map.
// @ts-expect-error — untyped .mjs tool imported for its exported pure functions.
import * as liveness from '../../../../scripts/build-liveness.mjs';

const { DEFAULTS, TIMEOUT_EXIT_CODE, classifyEnd, evaluateLiveness, exitCodeForReason, parseArgs, parsePositiveInt, resolveConfig } =
  liveness;

const exec = promisify(execFile);
const SCRIPT = resolve(__dirname, '../../../../scripts/build-liveness.mjs');

/** Run the CLI; returns exit code, and the parsed JSON event lines from stdout. */
async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout } = await exec('node', [SCRIPT, ...args], { env: { ...process.env, ...env } });
    return { code: 0, events: parseEvents(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: err.code ?? -1, events: parseEvents(err.stdout ?? '') };
  }
}

function parseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('build-liveness config: parsePositiveInt / resolveConfig', () => {
  it('falls back to the default when the env value is unset or empty', () => {
    expect(parsePositiveInt(undefined, 60, 'X')).toBe(60);
    expect(parsePositiveInt('', 60, 'X')).toBe(60);
  });

  it('parses a valid positive integer and rejects non-positive / non-integer values', () => {
    expect(parsePositiveInt('30', 60, 'X')).toBe(30);
    expect(() => parsePositiveInt('0', 60, 'X')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('-5', 60, 'X')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('1.5', 60, 'X')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('abc', 60, 'X')).toThrow(/positive integer/);
  });

  it('resolves the documented defaults into milliseconds when nothing is set', () => {
    const c = resolveConfig({});
    expect(c.timeoutMs).toBe(DEFAULTS.timeoutSec * 1000);
    expect(c.heartbeatIntervalMs).toBe(DEFAULTS.heartbeatSec * 1000);
    expect(c.killGraceMs).toBe(DEFAULTS.killGraceSec * 1000);
    expect(c.hookCmd).toBeNull();
  });

  it('honours env overrides and the optional lifecycle hook', () => {
    const c = resolveConfig({
      BUILD_TIMEOUT_SEC: '600',
      BUILD_HEARTBEAT_SEC: '30',
      BUILD_LIFECYCLE_HOOK: 'echo hi',
    });
    expect(c.timeoutMs).toBe(600_000);
    expect(c.heartbeatIntervalMs).toBe(30_000);
    expect(c.hookCmd).toBe('echo hi');
  });

  it('enforces the invariant that the timeout must exceed the heartbeat interval', () => {
    expect(() => resolveConfig({ BUILD_TIMEOUT_SEC: '60', BUILD_HEARTBEAT_SEC: '60' })).toThrow(/must exceed/);
    expect(() => resolveConfig({ BUILD_TIMEOUT_SEC: '30', BUILD_HEARTBEAT_SEC: '60' })).toThrow(/must exceed/);
  });
});

describe('build-liveness decision: evaluateLiveness', () => {
  const base = { startedAt: 0, timeoutMs: 1000, heartbeatIntervalMs: 100 };

  it('flags a heartbeat as due once the interval has elapsed since the last one', () => {
    expect(evaluateLiveness({ ...base, now: 50, lastHeartbeatAt: 0 }).heartbeatDue).toBe(false);
    expect(evaluateLiveness({ ...base, now: 100, lastHeartbeatAt: 0 }).heartbeatDue).toBe(true);
  });

  it('flags a timeout once elapsed reaches the hard limit', () => {
    expect(evaluateLiveness({ ...base, now: 999, lastHeartbeatAt: 999 }).timedOut).toBe(false);
    expect(evaluateLiveness({ ...base, now: 1000, lastHeartbeatAt: 1000 }).timedOut).toBe(true);
  });

  it('suppresses a heartbeat once timed out — the next event is the end', () => {
    const live = evaluateLiveness({ ...base, now: 5000, lastHeartbeatAt: 0 });
    expect(live.timedOut).toBe(true);
    expect(live.heartbeatDue).toBe(false);
  });
});

describe('build-liveness end classification', () => {
  it('maps a clean exit to success, a non-zero exit to fail, and any timeout to timeout', () => {
    expect(classifyEnd({ timedOut: false, exitCode: 0, signal: null })).toEqual({ reason: 'success', ok: true });
    expect(classifyEnd({ timedOut: false, exitCode: 1, signal: null }).reason).toBe('fail');
    expect(classifyEnd({ timedOut: false, exitCode: 0, signal: 'SIGKILL' }).reason).toBe('fail');
    // timeout wins even when the killed child looks like a plain failure.
    expect(classifyEnd({ timedOut: true, exitCode: 137, signal: 'SIGKILL' }).reason).toBe('timeout');
  });

  it('maps each reason to its process exit code (0 / 124 / child code)', () => {
    expect(exitCodeForReason('success', 0)).toBe(0);
    expect(exitCodeForReason('timeout', 137)).toBe(TIMEOUT_EXIT_CODE);
    expect(exitCodeForReason('fail', 7)).toBe(7);
    expect(exitCodeForReason('fail', null)).toBe(1);
  });
});

describe('build-liveness arg parsing', () => {
  it('reads --label and treats everything after -- as the verbatim command', () => {
    expect(parseArgs(['--label', 'task-abc', '--', 'pnpm', 'verify'])).toEqual({
      label: 'task-abc',
      command: ['pnpm', 'verify'],
    });
    expect(parseArgs(['--label=x', '--', 'echo', 'hi'])).toEqual({ label: 'x', command: ['echo', 'hi'] });
  });

  it('starts the command at the first non-flag token when no -- is given', () => {
    expect(parseArgs(['echo', 'hi'])).toEqual({ label: null, command: ['echo', 'hi'] });
    expect(parseArgs([])).toEqual({ label: null, command: [] });
  });
});

describe('build-liveness CLI lifecycle', () => {
  it('emits start then end(success) and exits 0 for a fast successful build', async () => {
    const { code, events } = await runCli(['--label', 'ok', '--', 'true']);
    expect(code).toBe(0);
    expect(events[0]).toMatchObject({ event: 'start', build: 'ok' });
    const end = events.at(-1);
    expect(end).toMatchObject({ event: 'end', reason: 'success' });
  });

  it('surfaces a failing build as end(fail) and mirrors the child exit code', async () => {
    const { code, events } = await runCli(['--', 'bash', '-c', 'exit 7']);
    expect(code).toBe(7);
    expect(events.at(-1)).toMatchObject({ event: 'end', reason: 'fail', exitCode: 7 });
  });

  it('hard-times-out a stalled build: heartbeat, then timeout, then exit 124', async () => {
    const { code, events } = await runCli(['--label', 'hung', '--', 'sleep', '30'], {
      BUILD_TIMEOUT_SEC: '2',
      BUILD_HEARTBEAT_SEC: '1',
    });
    expect(code).toBe(TIMEOUT_EXIT_CODE);
    expect(events.some((e) => e.event === 'heartbeat')).toBe(true);
    expect(events.some((e) => e.event === 'timeout')).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'end', reason: 'timeout' });
  }, 15_000);
});
