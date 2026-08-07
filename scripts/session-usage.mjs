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
 * Env overrides (testing): CLAUDE_PROJECTS_DIR, SESSION_USAGE_WORKDIR.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const workdir = process.env.SESSION_USAGE_WORKDIR ?? process.cwd();
const projectsDir = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

/** Claude Code encodes the workdir path into a directory name: / and . → - */
const encodedWorkdir = () => workdir.replace(/[/.]/g, '-');

const newestTranscript = () => {
  const dir = join(projectsDir, encodedWorkdir());
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path ?? null;
};

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

  const transcript = newestTranscript();
  if (!transcript) {
    console.error(`no transcript found under ${join(projectsDir, encodedWorkdir())}`);
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
