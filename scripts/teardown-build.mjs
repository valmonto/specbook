#!/usr/bin/env node
/**
 * teardown-build.mjs — per-build resource teardown, wired into the build
 * lifecycle so every dispatched build self-cleans instead of leaking.
 *
 * It is the `end`-event consumer of the liveness envelope
 * (`scripts/build-liveness.mjs`): set
 *
 *   BUILD_LIFECYCLE_HOOK="node scripts/teardown-build.mjs --worktree <path> [--db <sb_name>]"
 *
 * and the wrapper invokes this once per event with the event JSON in
 * `$BUILD_EVENT`. We act ONLY on the terminal `end` event — for EVERY reason
 * (`success | fail | timeout`) — and no-op on `start` / `heartbeat`. Run
 * directly (no `$BUILD_EVENT`) it acts immediately, which is how a parent runner
 * reaps an already-finished build's worktree.
 *
 * WHY THIS EXISTS: a 7-task run once left 16 git worktrees (~4 GB, one 1.5 GB)
 * plus an orphaned Vite dev stack behind on a 7.6 GB box, and a worktree removal
 * even failed because a build left an untracked `.env` behind. The manual reaper
 * (`scripts/reap-build-leaks.mjs`) is the periodic broom; this is the automatic,
 * per-build teardown that keeps the broom from ever having much to sweep.
 *
 * WHAT IT DOES for the ONE target worktree it is given:
 *   1. kills dev-stack processes whose cwd is under that worktree (api/vite);
 *   2. force-removes the git worktree (even with leftover untracked files) and
 *      prunes the admin refs;
 *   3. drops each `--db` throwaway DB it is told about — but only sb_* names.
 *
 * ┌─ SAFETY — the same discriminators that keep the reaper from taking the live ┐
 * │ site down apply here, reused verbatim:                                       │
 * │  • Processes: killed ONLY when cwd is strictly UNDER the target worktree     │
 * │    (`classifyCwd` from reap-build-leaks). The live specbook.valmonto.com     │
 * │    api (:3000) and web (:5173) run from the MAIN checkout — cwd is a sibling │
 * │    of `.claude/worktrees/`, never inside it — so they are never touched, and │
 * │    a CONCURRENT build's worktree is a sibling of THIS one, so its procs are  │
 * │    left alone too. The rustfs/object-store docker (:9000) is likewise off.   │
 * │  • Worktree: the target MUST be strictly under `.claude/worktrees/`; the     │
 * │    main checkout and anything outside are refused. And it REFUSES to remove  │
 * │    the worktree THIS process is running inside — you cannot git-remove your  │
 * │    own cwd, and a build subagent must never delete itself. The parent runner │
 * │    removes the current build's worktree; this reaps OTHER/finished ones.     │
 * │  • DBs: dropped ONLY when the name matches the throwaway `sb_` namespace.    │
 * │    valmatic* / specbook* (and any non-sb_ name) are refused outright.        │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * SAFETY DEFAULT: `--dry-run` prints what it would do without touching anything.
 * The lifecycle hook runs WITHOUT it (auto-teardown must actually act); the
 * guardrails above are what make acting-by-default safe.
 *
 * USAGE:
 *   node scripts/teardown-build.mjs --worktree <path>            # act on end/manual
 *   node scripts/teardown-build.mjs --worktree <path> --db sb_x  # also drop DB sb_x
 *   node scripts/teardown-build.mjs --worktree <path> --dry-run  # print only
 *
 * CONFIG (env — DB connection, defaults match scripts/dev-stack.sh):
 *   PG_HOST/PG_PORT/PG_USER/PGPASSWORD (default 127.0.0.1/5432/valmatic/valmatic)
 */
import { execFileSync } from 'node:child_process';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyCwd, scanProcs, selfAncestry } from './reap-build-leaks.mjs';

// ── Pure, exported, unit-tested core (no /proc, no git, no dropdb) ────────────

/**
 * Parse the `$BUILD_EVENT` JSON one-liner the liveness wrapper hands the hook.
 * Returns the parsed object, or null when absent/blank/unparseable — a broken
 * hook payload must never crash the fire-and-forget hook.
 * @param {string|undefined|null} raw
 * @returns {Record<string, unknown> | null}
 */
export function parseBuildEvent(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this invocation should act. Wired as a lifecycle hook we are
 * called on EVERY event (`start`/`heartbeat`/`end`) — act only on `end`, and on
 * end for every reason (success, fail, timeout). Run directly (no BUILD_EVENT in
 * the env) we act immediately: that is the manual / parent-runner reap path.
 * @param {Record<string,string|undefined>} env
 * @returns {{ act: boolean, reason: string }}
 */
export function shouldAct(env = {}) {
  const raw = env.BUILD_EVENT;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { act: true, reason: 'invoked directly (no BUILD_EVENT) — manual/parent reap' };
  }
  const event = parseBuildEvent(raw);
  if (!event) return { act: false, reason: 'unparseable BUILD_EVENT — no-op' };
  if (event.event === 'end') {
    return { act: true, reason: `end event (reason=${event.reason ?? 'unknown'})` };
  }
  return { act: false, reason: `non-terminal event (${event.event}) — no-op` };
}

/**
 * Gate the ONE worktree we were told to tear down. It must be strictly under the
 * worktrees root (never the main checkout / anything outside), and it must NOT
 * contain the cwd of THIS process — you cannot `git worktree remove` the tree
 * you are standing in, and a build subagent must never delete itself.
 *
 * @param {string} target          worktree path to remove
 * @param {string} worktreesRoot   absolute `<repo>/.claude/worktrees`
 * @param {string} selfCwd         cwd of the running teardown process
 * @returns {{ action: 'remove'|'refuse', reason: string }}
 */
export function classifyTarget(target, worktreesRoot, selfCwd) {
  if (!target) return { action: 'refuse', reason: 'no --worktree given' };
  const root = resolve(worktreesRoot);
  const wt = resolve(target);
  const rel = relative(root, wt);
  const under = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!under) {
    return {
      action: 'refuse',
      reason: 'target is not strictly under the worktrees root (main checkout / outside)',
    };
  }
  if (selfCwd) {
    const inSelf = relative(wt, resolve(selfCwd));
    const runningInside = inSelf === '' || (!inSelf.startsWith('..') && !isAbsolute(inSelf));
    if (runningInside) {
      return {
        action: 'refuse',
        reason: 'refusing to remove the worktree this process is running inside',
      };
    }
  }
  return { action: 'remove', reason: 'orphaned build worktree under the worktrees root' };
}

/**
 * Gate a database drop. Only the throwaway `sb_` namespace is ever droppable;
 * every other name — above all `valmatic*` / `specbook*` — is refused. Mirrors
 * the guardrail dev-stack.sh enforces when it CREATES the DB, so a mis-wired
 * `--db valmatic_test` can never destroy real data.
 * @param {string} name
 * @returns {{ action: 'drop'|'keep', reason: string }}
 */
export function classifyDb(name) {
  if (!name || typeof name !== 'string') return { action: 'keep', reason: 'no db name' };
  if (!/^sb_[A-Za-z0-9_]*$/.test(name)) {
    return { action: 'keep', reason: `not a throwaway sb_* name (refused: ${name})` };
  }
  return { action: 'drop', reason: 'throwaway sb_* database' };
}

// ── CLI (only when executed directly, inert when imported by the test) ────────

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function parseArgv(argv) {
  const opts = { worktree: null, dbs: [], dryRun: false, worktreesRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worktree') opts.worktree = argv[++i] ?? null;
    else if (a.startsWith('--worktree=')) opts.worktree = a.slice('--worktree='.length);
    else if (a === '--db') opts.dbs.push(argv[++i]);
    else if (a.startsWith('--db=')) opts.dbs.push(a.slice('--db='.length));
    else if (a === '--worktrees-root') opts.worktreesRoot = argv[++i] ?? null;
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function log(msg) {
  // stderr so we never pollute a caller that parses stdout event JSON.
  process.stderr.write(`teardown-build: ${msg}\n`);
}

function killWorktreeProcs(target, dryRun) {
  const skip = selfAncestry();
  let killed = 0;
  for (const p of scanProcs()) {
    // Reuse the reaper's discriminator with the TARGET worktree as the root:
    // kills only processes strictly under this worktree (a sibling worktree's
    // procs and the main-checkout live site are outside it → kept).
    if (classifyCwd(p.cwd, target).action !== 'kill' || skip.has(p.pid)) continue;
    log(`${dryRun ? 'would kill' : 'killing'} pid ${p.pid}  ${p.cwd}  ::  ${p.cmd.slice(0, 80)}`);
    if (!dryRun) {
      try {
        process.kill(p.pid, 'SIGTERM');
        killed++;
      } catch (e) {
        log(`  (failed to signal ${p.pid}: ${e.message})`);
      }
    } else {
      killed++;
    }
  }
  log(`processes under target worktree: ${killed}`);
}

function removeWorktree(target, worktreesRoot, dryRun) {
  const verdict = classifyTarget(target, worktreesRoot, process.cwd());
  if (verdict.action === 'refuse') {
    log(`NOT removing worktree — ${verdict.reason}`);
    return;
  }
  log(`${dryRun ? 'would remove' : 'removing'} worktree ${target} (force) + prune`);
  if (dryRun) return;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', target], { stdio: 'inherit' });
  } catch (e) {
    log(`  (remove failed: ${e.message})`);
  }
  try {
    execFileSync('git', ['worktree', 'prune'], { stdio: 'inherit' });
  } catch (e) {
    log(`  (prune failed: ${e.message})`);
  }
}

function dropDbs(dbs, dryRun) {
  if (dbs.length === 0) return;
  const host = process.env.PG_HOST ?? '127.0.0.1';
  const port = process.env.PG_PORT ?? '5432';
  const user = process.env.PG_USER ?? 'valmatic';
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'valmatic' };
  for (const name of dbs) {
    const verdict = classifyDb(name);
    if (verdict.action === 'keep') {
      log(`NOT dropping db — ${verdict.reason}`);
      continue;
    }
    log(`${dryRun ? 'would drop' : 'dropping'} db ${name}`);
    if (dryRun) continue;
    try {
      execFileSync('dropdb', ['--if-exists', '--force', '-h', host, '-p', port, '-U', user, name], {
        stdio: 'ignore',
        env,
      });
    } catch (e) {
      log(`  (dropdb ${name} failed: ${e.message})`);
    }
  }
}

function main() {
  const opts = parseArgv(process.argv.slice(2));
  const decision = shouldAct(process.env);
  if (!decision.act) {
    // Silent-ish no-op: this fires on every start/heartbeat, so keep it quiet.
    return;
  }
  if (!opts.worktree) {
    log('no --worktree given — nothing to tear down');
    return;
  }
  const worktreesRoot = opts.worktreesRoot
    ? resolve(opts.worktreesRoot)
    : join(repoRoot(), '.claude', 'worktrees');
  const target = resolve(opts.worktree);
  log(`${opts.dryRun ? 'DRY-RUN' : 'teardown'} — ${decision.reason}`);
  log(`target worktree: ${target}`);

  // Kill the build's dev-stack procs BEFORE removing its worktree, so nothing is
  // still cwd-inside it (a live process inside a worktree blocks a clean remove).
  killWorktreeProcs(target, opts.dryRun);
  removeWorktree(target, worktreesRoot, opts.dryRun);
  dropDbs(opts.dbs, opts.dryRun);
  log(opts.dryRun ? 'dry run only — nothing killed, removed, or dropped.' : 'teardown complete.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
