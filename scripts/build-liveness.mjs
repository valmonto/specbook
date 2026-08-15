#!/usr/bin/env node
/**
 * build-liveness.mjs — a liveness envelope around a dispatched build so it can
 * never hang silently. It wraps a build command with (1) a periodic heartbeat
 * the orchestrator/board can observe and (2) a hard per-build timeout that
 * auto-terminates a stalled build with a clear reason instead of hanging
 * forever.
 *
 * WHY THIS EXISTS: a dispatched build subagent once ran 34+ minutes with a
 * stale 113-byte output, no progress and no timeout — the orchestrator only
 * noticed by manually stat-ing the output file. A tool that builds itself
 * unattended cannot have builds that stall invisibly. This wrapper is the
 * shared lifecycle plumbing the keep-claim-alive and resource-teardown tickets
 * build on: it emits a structured `start → heartbeat* → end` event stream, and
 * `end.reason` is one of `success | fail | timeout`.
 *
 * ┌─ LIFECYCLE HOOK ─────────────────────────────────────────────────────────┐
 * │ Every event is written to stdout as one JSON line (observable by tailing   │
 * │ the log). If BUILD_LIFECYCLE_HOOK is set, that command is ALSO invoked once │
 * │ per event with the event JSON in the BUILD_EVENT env var — fire-and-forget, │
 * │ best-effort, never blocking the build. Consumers:                          │
 * │   • keep-claim-alive  → on `heartbeat`, stamp the MCP claim so a long build │
 * │                         is never mistaken for a dead runner.               │
 * │   • resource-teardown → on `end`, reap the build's worktree + dev stack.    │
 * │   • orchestrator      → on `end.reason==='timeout'`, return the task/claim  │
 * │                         to a safe state (release/fail with reason) so the   │
 * │                         queue is never stuck on a dead build.              │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * CONFIG (env — all documented in .claude/commands/dispatch.md):
 *   BUILD_TIMEOUT_SEC     (default 1200 = 20 min)  hard per-build timeout
 *   BUILD_HEARTBEAT_SEC   (default 60)             heartbeat interval
 *   BUILD_KILL_GRACE_SEC  (default 10)             SIGTERM→SIGKILL grace on timeout
 *   BUILD_LIFECYCLE_HOOK  (unset)                  command invoked per event
 *
 * USAGE:
 *   node scripts/build-liveness.mjs [--label <name>] -- <command> [args...]
 *   node scripts/build-liveness.mjs -- pnpm verify
 *   BUILD_TIMEOUT_SEC=600 node scripts/build-liveness.mjs --label task-abc -- ./build.sh
 *
 * EXIT CODE mirrors the end reason: 0 success, 124 timeout (GNU timeout
 * convention), otherwise the child's own non-zero code (fail).
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ── Pure, exported, unit-tested core (no I/O, no timers, no child processes) ──

/** Documented defaults, in seconds — the single source the CLI and docs cite. */
export const DEFAULTS = Object.freeze({
  timeoutSec: 1200, // 20 minutes — a build past this is treated as hung
  heartbeatSec: 60, // one liveness signal per minute
  killGraceSec: 10, // SIGTERM, then SIGKILL after this grace on timeout
});

/** GNU `timeout`-compatible exit code for a build we killed for exceeding its limit. */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * Parse a positive-integer env value, falling back to a default. Empty/unset →
 * fallback; anything present-but-not-a-positive-integer is a hard config error
 * (fail loudly rather than silently run with a surprising limit).
 * @returns {number}
 */
export function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Resolve the liveness config from an env-like object into milliseconds.
 * Validates every knob and the one cross-field invariant: the hard timeout must
 * exceed the heartbeat interval (a build must get at least one heartbeat before
 * it can time out). Throws on any invalid combination.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{ timeoutMs:number, heartbeatIntervalMs:number, killGraceMs:number, hookCmd:string|null }}
 */
export function resolveConfig(env = {}) {
  const timeoutSec = parsePositiveInt(env.BUILD_TIMEOUT_SEC, DEFAULTS.timeoutSec, 'BUILD_TIMEOUT_SEC');
  const heartbeatSec = parsePositiveInt(env.BUILD_HEARTBEAT_SEC, DEFAULTS.heartbeatSec, 'BUILD_HEARTBEAT_SEC');
  const killGraceSec = parsePositiveInt(env.BUILD_KILL_GRACE_SEC, DEFAULTS.killGraceSec, 'BUILD_KILL_GRACE_SEC');
  if (timeoutSec <= heartbeatSec) {
    throw new Error(
      `BUILD_TIMEOUT_SEC (${timeoutSec}) must exceed BUILD_HEARTBEAT_SEC (${heartbeatSec}) — ` +
        'a build must get at least one heartbeat before it can time out.',
    );
  }
  const hook = env.BUILD_LIFECYCLE_HOOK;
  return {
    timeoutMs: timeoutSec * 1000,
    heartbeatIntervalMs: heartbeatSec * 1000,
    killGraceMs: killGraceSec * 1000,
    hookCmd: hook && hook.trim() !== '' ? hook : null,
  };
}

/**
 * The liveness decision, pure and time-injectable. Given when the build started,
 * when the last heartbeat fired, and the current instant, decide whether the
 * build has exceeded its hard timeout and whether a fresh heartbeat is due.
 *
 * @param {{ startedAt:number, now:number, lastHeartbeatAt:number, timeoutMs:number, heartbeatIntervalMs:number }} s
 * @returns {{ elapsedMs:number, sinceHeartbeatMs:number, timedOut:boolean, heartbeatDue:boolean }}
 */
export function evaluateLiveness({ startedAt, now, lastHeartbeatAt, timeoutMs, heartbeatIntervalMs }) {
  const elapsedMs = Math.max(0, now - startedAt);
  const sinceHeartbeatMs = Math.max(0, now - lastHeartbeatAt);
  const timedOut = elapsedMs >= timeoutMs;
  // No heartbeat once we've decided to time out — the next event is the `end`.
  const heartbeatDue = !timedOut && sinceHeartbeatMs >= heartbeatIntervalMs;
  return { elapsedMs, sinceHeartbeatMs, timedOut, heartbeatDue };
}

/**
 * Classify how a build ended into the one canonical reason the hook exposes.
 * `timedOut` wins over the exit code (a build we SIGKILLed for timing out may
 * exit non-zero, but the reason is the timeout, not the failure it looks like).
 *
 * @param {{ timedOut:boolean, exitCode:number|null, signal:string|null }} e
 * @returns {{ reason:'success'|'fail'|'timeout', ok:boolean }}
 */
export function classifyEnd({ timedOut, exitCode, signal }) {
  if (timedOut) return { reason: 'timeout', ok: false };
  const success = exitCode === 0 && !signal;
  return { reason: success ? 'success' : 'fail', ok: success };
}

/**
 * The process exit code that mirrors an end reason: 0 for success, 124 for
 * timeout (GNU `timeout` convention), otherwise the child's own non-zero code
 * (or 1 if it died from a signal without a code).
 * @returns {number}
 */
export function exitCodeForReason(reason, childExitCode) {
  if (reason === 'success') return 0;
  if (reason === 'timeout') return TIMEOUT_EXIT_CODE;
  return childExitCode && childExitCode !== 0 ? childExitCode : 1;
}

/**
 * Split argv into an optional `--label <name>` and the build command. Everything
 * after a bare `--` is the command verbatim; before it, only `--label` is
 * recognised. Without `--`, the first token starts the command.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ label:string|null, command:string[] }}
 */
export function parseArgs(argv) {
  let label = null;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--label') {
      label = argv[++i] ?? null;
      continue;
    }
    if (a.startsWith('--label=')) {
      label = a.slice('--label='.length);
      continue;
    }
    // First non-flag token: the command begins here (no `--` used).
    break;
  }
  return { label, command: argv.slice(i) };
}

// ── CLI (only when executed directly, inert when imported by the test) ────────

function nowIso() {
  return new Date().toISOString();
}

function main() {
  const { label, command } = parseArgs(process.argv.slice(2));
  if (command.length === 0) {
    console.error('usage: build-liveness.mjs [--label <name>] -- <command> [args...]');
    process.exit(2);
  }

  let config;
  try {
    config = resolveConfig(process.env);
  } catch (e) {
    console.error(`build-liveness: bad config — ${e.message}`);
    process.exit(2);
  }
  const { timeoutMs, heartbeatIntervalMs, killGraceMs, hookCmd } = config;
  const build = label ?? command[0];

  // One JSON line per event on stdout, plus the optional fire-and-forget hook.
  const emit = (event) => {
    const payload = { build, ts: nowIso(), ...event };
    const line = JSON.stringify(payload);
    process.stdout.write(line + '\n');
    if (hookCmd) {
      try {
        const h = spawn(hookCmd, { shell: true, stdio: 'ignore', env: { ...process.env, BUILD_EVENT: line } });
        h.on('error', () => {}); // best-effort: a broken hook must never fail the build
        h.unref();
      } catch {
        /* best-effort */
      }
    }
  };

  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let timedOut = false;
  let ended = false;

  // Detached so the child gets its own process group; on timeout we signal the
  // whole group (`-pid`) so build children (nest/vite/pnpm) die with it.
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true });

  emit({ event: 'start', pid: child.pid, cmd: command, timeoutMs, heartbeatIntervalMs });

  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };

  // Poll granularity: at most the heartbeat interval, at most 5s so a hard
  // timeout is accurate to within a few seconds even on a long heartbeat.
  const pollMs = Math.max(50, Math.min(heartbeatIntervalMs, 5000));
  let killGraceTimer = null;

  const poll = setInterval(() => {
    if (ended) return;
    const live = evaluateLiveness({
      startedAt,
      now: Date.now(),
      lastHeartbeatAt,
      timeoutMs,
      heartbeatIntervalMs,
    });
    if (live.timedOut) {
      if (timedOut) return; // already tearing down
      timedOut = true;
      clearInterval(poll);
      emit({ event: 'timeout', elapsedMs: live.elapsedMs, action: 'terminating build' });
      signalGroup('SIGTERM');
      // Escalate to SIGKILL if it ignores the polite signal.
      killGraceTimer = setTimeout(() => signalGroup('SIGKILL'), killGraceMs);
      killGraceTimer.unref?.();
      return;
    }
    if (live.heartbeatDue) {
      lastHeartbeatAt = Date.now();
      emit({ event: 'heartbeat', elapsedMs: live.elapsedMs });
    }
  }, pollMs);
  poll.unref?.();

  const finish = (exitCode, signal) => {
    if (ended) return;
    ended = true;
    clearInterval(poll);
    if (killGraceTimer) clearTimeout(killGraceTimer);
    const { reason } = classifyEnd({ timedOut, exitCode, signal });
    emit({ event: 'end', reason, elapsedMs: Date.now() - startedAt, exitCode, signal });
    process.exit(exitCodeForReason(reason, exitCode));
  };

  child.on('exit', (code, signal) => finish(code, signal));
  child.on('error', (err) => {
    if (ended) return;
    ended = true;
    clearInterval(poll);
    emit({ event: 'end', reason: 'fail', elapsedMs: Date.now() - startedAt, error: err.message });
    process.exit(1);
  });

  // Forward an interrupt of the wrapper down to the build, then let its exit
  // drive our own — no orphaned build group left behind.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => signalGroup(sig));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
