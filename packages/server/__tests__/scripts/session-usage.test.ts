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
  };
  const run = async (...args: string[]) => {
    const { stdout } = await exec('node', [SCRIPT, ...args], { env });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  };

  const usageLine = (
    id: string,
    usage: Record<string, number>,
  ): string => JSON.stringify({ type: 'assistant', message: { id, usage } }) + '\n';

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
