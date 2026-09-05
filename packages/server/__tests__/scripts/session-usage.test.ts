import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const SCRIPT = resolve(__dirname, '../../../../scripts/session-usage.mjs');

/**
 * The measured-cost script, tested against the exact traps measured on a
 * real transcript: duplicated message ids (once per content block), the
 * dominant cache counters, torn lines, and the baseline/report delta
 * protocol including the restarted-session fallback.
 */
describe('session-usage.mjs', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'su-workdir-'));
  const projects = mkdtempSync(join(tmpdir(), 'su-projects-'));
  const transcriptDir = join(projects, workdir.replace(/[/.]/g, '-'));
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = join(transcriptDir, 'session-1.jsonl');

  const env = {
    ...process.env,
    SESSION_USAGE_WORKDIR: workdir,
    CLAUDE_PROJECTS_DIR: projects,
    // Force main-session mode: the suite itself may run inside a subagent (whose
    // ambient CLAUDE_CODE_CHILD_SESSION would otherwise divert resolution).
    CLAUDE_CODE_CHILD_SESSION: '',
  };
  const run = async (...args: string[]) => {
    const { stdout } = await exec('node', [SCRIPT, ...args], { env });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  };

  const usageLine = (id: string, usage: Record<string, number>): string =>
    JSON.stringify({ type: 'assistant', message: { id, usage } }) + '\n';

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  });

  it('dedupes repeated message ids and sums all four counters', async () => {
    const dup = usageLine('msg_1', {
      input_tokens: 10,
      output_tokens: 100,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 10_000,
    });
    writeFileSync(
      transcript,
      // msg_1 written 3× (one per content block — the real overcount trap),
      // a second real message, a usage-less synthetic, a non-assistant line
      // and a torn final line mid-write.
      dup +
        dup +
        dup +
        usageLine('msg_2', { input_tokens: 5, output_tokens: 50 }) +
        JSON.stringify({ type: 'assistant', message: { id: 'msg_3' } }) +
        '\n' +
        JSON.stringify({ type: 'user', message: { content: 'hi' } }) +
        '\n' +
        '{"type":"assistant","message":{"id":"torn',
    );

    const totals = await run();
    expect(totals).toMatchObject({
      input: 15,
      output: 150,
      cacheCreation: 1_000,
      cacheRead: 10_000,
    });
  });

  it('baseline → report yields the delta, with cache fields folded into tokensIn', async () => {
    await run('baseline', 'task-1');
    appendFileSync(
      transcript,
      // Newline first: the previous test left a torn line mid-write, which
      // the real writer would complete before appending the next entry.
      '\n' +
        usageLine('msg_4', {
          input_tokens: 7,
          output_tokens: 70,
          cache_creation_input_tokens: 700,
          cache_read_input_tokens: 7_000,
        }),
    );

    const report = await run('report', 'task-1');
    expect(report).toEqual({ tokensIn: 7 + 700 + 7_000, tokensOut: 70, baseline: 'ok' });
  });

  it('a missing or stale baseline degrades to whole-session totals with the marker', async () => {
    const missing = await run('report', 'task-never-baselined');
    expect(missing.baseline).toBe('missing');
    expect(missing.tokensIn).toBeGreaterThan(0);

    // Session restart: a NEWER transcript file appears — the old baseline
    // must not produce a cross-session delta.
    await run('baseline', 'task-2');
    const restarted = join(transcriptDir, 'session-2.jsonl');
    writeFileSync(restarted, usageLine('msg_9', { input_tokens: 3, output_tokens: 30 }));
    const future = Date.now() / 1000 + 60;
    utimesSync(restarted, future, future);

    const report = await run('report', 'task-2');
    expect(report).toEqual({ tokensIn: 3, tokensOut: 30, baseline: 'missing' });
  });
});

/**
 * Subagent (dispatched build) attribution — the 0/0 bug. A dispatched build
 * runs as a Claude Code subagent inside a git worktree; its tokens land in a
 * nested sidechain transcript of the PARENT session
 * (<projects>/<enc>/<parentSessionId>/subagents/agent-<id>.jsonl), which the
 * runner's own transcript never sees. When we ARE that subagent
 * (CLAUDE_CODE_CHILD_SESSION set), the script must resolve our own sidechain.
 */
describe('session-usage.mjs — subagent sidechain resolution', () => {
  const projects = mkdtempSync(join(tmpdir(), 'su-sub-projects-'));
  const SESSION = 'parent-session-xyz';
  // The runner checkout and the worktree the subagent runs in (its basename is
  // the subagent id). Both live under a temp root: the script mkdirs
  // `<workdir>/.claude` for the baseline file, so a fixed `/opt/specbook`
  // path only passes on the one box where that directory is writable.
  const runnerDir = mkdtempSync(join(tmpdir(), 'su-sub-runner-'));
  const workdir = join(runnerDir, '.claude', 'worktrees', 'agent-abc123');
  // The sidechain lives under the RUNNER's project-encoded dir, not the worktree.
  const subagentsDir = join(projects, runnerDir.replace(/[/.]/g, '-'), SESSION, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const ownTranscript = join(subagentsDir, 'agent-abc123.jsonl');

  const subEnv = {
    ...process.env,
    SESSION_USAGE_WORKDIR: workdir,
    CLAUDE_PROJECTS_DIR: projects,
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: SESSION,
  };
  const runSub = async (...args: string[]) => {
    const { stdout } = await exec('node', [SCRIPT, ...args], { env: subEnv });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  };
  const usageLine = (id: string, usage: Record<string, number>): string =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      agentId: 'abc123',
      message: { id, usage },
    }) + '\n';

  afterAll(() => {
    rmSync(projects, { recursive: true, force: true });
    rmSync(runnerDir, { recursive: true, force: true });
  });

  it('measures the subagent OWN sidechain, not the (absent) worktree-encoded path', async () => {
    writeFileSync(
      ownTranscript,
      usageLine('sa_1', {
        input_tokens: 4,
        output_tokens: 40,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 4_000,
      }),
    );
    const totals = await runSub();
    expect(totals).toMatchObject({
      transcript: ownTranscript,
      input: 4,
      output: 40,
      cacheCreation: 400,
      cacheRead: 4_000,
    });
  });

  it('reports a non-zero measured cost for a dispatched build (baseline → report delta)', async () => {
    await runSub('baseline', 'sub-task');
    appendFileSync(
      ownTranscript,
      usageLine('sa_2', {
        input_tokens: 6,
        output_tokens: 60,
        cache_creation_input_tokens: 600,
        cache_read_input_tokens: 6_000,
      }),
    );
    const report = await runSub('report', 'sub-task');
    expect(report).toEqual({ tokensIn: 6 + 600 + 6_000, tokensOut: 60, baseline: 'ok' });
    // The whole point: never the silent 0/0.
    expect(report.tokensIn).toBeGreaterThan(0);
  });

  it('prefers OUR sidechain by name when siblings exist, never a sibling', async () => {
    writeFileSync(
      join(subagentsDir, 'agent-sibling.jsonl'),
      usageLine('sib_1', { input_tokens: 9_999, output_tokens: 9_999 }),
    );
    const totals = await runSub();
    expect(totals.transcript).toBe(ownTranscript);
    expect(totals.output).not.toBe(9_999);
  });

  it('refuses to guess (fails loudly) when several siblings exist and none is ours', async () => {
    const orphanProjects = mkdtempSync(join(tmpdir(), 'su-orphan-'));
    const dir = join(orphanProjects, '-opt-specbook', SESSION, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-one.jsonl'),
      usageLine('o1', { input_tokens: 1, output_tokens: 1 }),
    );
    writeFileSync(
      join(dir, 'agent-two.jsonl'),
      usageLine('o2', { input_tokens: 2, output_tokens: 2 }),
    );
    await expect(
      exec('node', [SCRIPT], {
        env: { ...subEnv, CLAUDE_PROJECTS_DIR: orphanProjects },
      }),
    ).rejects.toMatchObject({ code: 1 });
    rmSync(orphanProjects, { recursive: true, force: true });
  });
});
