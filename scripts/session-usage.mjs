#!/usr/bin/env node
/**
 * Measured token usage for the CURRENT Claude Code session — the ground
 * truth behind report_cost, replacing agent self-estimates (which were
 * measured to be off by three orders of magnitude).
 *
 * Reads the session transcript Claude Code writes to
 * ~/.claude/projects/<workdir-encoded>/<sessionId>.jsonl and sums the exact
 * per-message usage counters. Three correctness rules, each one measured
 * against a real 74MB transcript:
 *
 * 1. DEDUPE by message.id — the same assistant message is written once per
 *    content block (up to 16×) with identical usage; naive summing
 *    overcounts ~62%.
 * 2. CACHE FIELDS DOMINATE — tokensIn = input + cache_creation + cache_read
 *    (the input-class volume Anthropic actually processes); uncached input
 *    alone is noise.
 * 3. DELTAS, not totals — one runner session spans many tasks, so per-task
 *    cost is totals-at-report minus totals-at-baseline.
 *
 * Usage:
 *   node scripts/session-usage.mjs                  # print session totals
 *   node scripts/session-usage.mjs baseline <task>  # snapshot totals
 *   node scripts/session-usage.mjs report <task>    # delta since baseline
 *
 * `report` prints {tokensIn, tokensOut, baseline} — feed tokensIn/tokensOut
 * straight to report_cost. baseline:"missing" means the snapshot was lost
 * (runner restarted mid-task) and the figures are whole-session totals —
 * an over-attribution, flagged so the runner can say so.
 *
 * SUBAGENT (dispatched build) transcripts. A dispatched build runs as a
 * Claude Code SUBAGENT inside its own git worktree, and Claude Code writes its
 * transcript NOT under the worktree's own encoded path but as a nested
 * sidechain file of the PARENT (runner) session:
 *   <projects>/<enc(project root)>/<parentSessionId>/subagents/agent-<id>.jsonl
 * So measuring the claimant runner's own transcript misses every subagent
 * token — that is the 0/0 under-count this script now closes. When we are
 * ourselves a subagent (CLAUDE_CODE_CHILD_SESSION is set), we resolve OUR OWN
 * sidechain file, keyed by the parent session id (CLAUDE_CODE_SESSION_ID) and
 * our subagent id (the worktree basename, `agent-<id>`). The required flow is
 * therefore: the dispatched subagent runs `baseline`/`report` in its own
 * transcript and reports its own measured cost (see .claude/commands/dispatch.md).
 * Inline builds keep measuring the runner's main transcript, unchanged.
 *
 * Env overrides (testing): CLAUDE_PROJECTS_DIR, SESSION_USAGE_WORKDIR.
 * Subagent context comes from CLAUDE_CODE_CHILD_SESSION + CLAUDE_CODE_SESSION_ID
 * (set by Claude Code); tests drive the same knobs.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const workdir = process.env.SESSION_USAGE_WORKDIR ?? process.cwd();
const projectsDir = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

/** Claude Code encodes a directory path into a projects dir name: / and . → - */
const encodePath = (p) => p.replace(/[/.]/g, '-');

const newestJsonl = (dir) => {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
};

/** Main-session transcript: newest top-level jsonl under the workdir's own dir. */
const mainTranscript = () => newestJsonl(join(projectsDir, encodePath(workdir)));

/**
 * Our own subagent sidechain transcript, or null when we are not a subagent /
 * it cannot be identified unambiguously. The parent session folder can sit
 * under any project-encoded dir (the runner's project root, not our worktree),
 * so we scan for the one holding this session's subagents/. We take our own
 * file by name (agent-<worktree basename>.jsonl); if that is absent we accept a
 * lone sidechain, but REFUSE to guess among several — an unresolved subagent
 * must surface as "no transcript", never a silent mis-attribution.
 */
const subagentTranscript = () => {
  if (!process.env.CLAUDE_CODE_CHILD_SESSION) return null;
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId || !existsSync(projectsDir)) return null;
  for (const entry of readdirSync(projectsDir)) {
    const subagentsDir = join(projectsDir, entry, sessionId, 'subagents');
    if (!existsSync(subagentsDir)) continue;
    const own = join(subagentsDir, `${basename(workdir)}.jsonl`);
    if (existsSync(own)) return own;
    const jsonls = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
    if (jsonls.length === 1) return join(subagentsDir, jsonls[0]);
    return null; // several siblings, none ours by name — do not guess
  }
  return null;
};

/**
 * A subagent measures its own sidechain; everyone else the main transcript.
 * The CLAUDE_CODE_CHILD_SESSION gate is load-bearing: a RUNNER session's folder
 * also contains a subagents/ dir (its children's), and must never read those.
 */
const resolveTranscript = () => subagentTranscript() ?? mainTranscript();

const sumTranscript = async (path) => {
  // Last write per message.id wins; repeats carry identical usage anyway.
  const byMessage = new Map();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn last line while the session is writing
    }
    if (entry?.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    const id = entry.message?.id;
    if (!usage || !id) continue;
    byMessage.set(id, usage);
  }
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of byMessage.values()) {
    totals.input += u.input_tokens ?? 0;
    totals.output += u.output_tokens ?? 0;
    totals.cacheCreation += u.cache_creation_input_tokens ?? 0;
    totals.cacheRead += u.cache_read_input_tokens ?? 0;
  }
  return totals;
};

const baselinePath = (taskId) => join(workdir, '.claude', `cost-baseline-${taskId}.json`);

const main = async () => {
  const [mode, taskId] = process.argv.slice(2);
  if ((mode === 'baseline' || mode === 'report') && !/^[A-Za-z0-9-]{1,64}$/.test(taskId ?? '')) {
    console.error('usage: session-usage.mjs [baseline|report] <taskId>');
    process.exit(2);
  }

  const transcript = resolveTranscript();
  if (!transcript) {
    const where = process.env.CLAUDE_CODE_CHILD_SESSION
      ? `subagent sidechain for session ${process.env.CLAUDE_CODE_SESSION_ID ?? '(unset)'} under ${projectsDir}`
      : join(projectsDir, encodePath(workdir));
    console.error(`no transcript found: ${where}`);
    process.exit(1);
  }
  const totals = await sumTranscript(transcript);

  if (mode === 'baseline') {
    mkdirSync(join(workdir, '.claude'), { recursive: true });
    writeFileSync(baselinePath(taskId), JSON.stringify({ ...totals, transcript }));
    console.log(JSON.stringify({ baselined: taskId, ...totals }));
    return;
  }

  if (mode === 'report') {
    let base = null;
    if (existsSync(baselinePath(taskId))) {
      try {
        base = JSON.parse(readFileSync(baselinePath(taskId), 'utf8'));
      } catch {
        base = null;
      }
    }
    // A different transcript than the baseline's means the session restarted:
    // the delta would mix two sessions, so fall back to whole-session totals.
    const usable = base !== null && base.transcript === transcript;
    const delta = (key) => (usable ? Math.max(0, totals[key] - (base[key] ?? 0)) : totals[key]);
    console.log(
      JSON.stringify({
        tokensIn: delta('input') + delta('cacheCreation') + delta('cacheRead'),
        tokensOut: delta('output'),
        baseline: usable ? 'ok' : 'missing',
      }),
    );
    return;
  }

  console.log(JSON.stringify({ transcript, ...totals }));
};

await main();
