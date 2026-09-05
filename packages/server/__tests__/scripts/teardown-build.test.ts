import { describe, expect, it } from 'vitest';

// The per-build teardown is a plain .mjs tool in scripts/; we import its PURE
// decision core (no /proc, no git, no dropdb) and prove the guardrails that keep
// it from ever taking the live site down or dropping a real database.
import {
  classifyDb,
  classifyTarget,
  parseBuildEvent,
  shouldAct,
  // @ts-expect-error — untyped .mjs tool imported for its exported pure functions.
  // (The directive sits on the line TypeScript reports: the module specifier.)
} from '../../../../scripts/teardown-build.mjs';

const ROOT = '/opt/specbook/.claude/worktrees';

describe('teardown-build: shouldAct (lifecycle-event gate)', () => {
  it('acts only on the terminal end event — for every end reason', () => {
    for (const reason of ['success', 'fail', 'timeout']) {
      const ev = JSON.stringify({ build: 't', event: 'end', reason });
      expect(shouldAct({ BUILD_EVENT: ev }).act).toBe(true);
    }
  });

  it('no-ops on non-terminal start / heartbeat events', () => {
    expect(shouldAct({ BUILD_EVENT: JSON.stringify({ event: 'start' }) }).act).toBe(false);
    expect(shouldAct({ BUILD_EVENT: JSON.stringify({ event: 'heartbeat' }) }).act).toBe(false);
  });

  it('acts when invoked directly (no BUILD_EVENT) — the manual / parent reap path', () => {
    expect(shouldAct({}).act).toBe(true);
    expect(shouldAct({ BUILD_EVENT: '' }).act).toBe(true);
  });

  it('no-ops on an unparseable BUILD_EVENT rather than crashing the hook', () => {
    expect(shouldAct({ BUILD_EVENT: 'not json' }).act).toBe(false);
  });
});

describe('teardown-build: parseBuildEvent', () => {
  it('parses a valid event JSON line', () => {
    expect(parseBuildEvent('{"event":"end","reason":"success"}')).toMatchObject({
      event: 'end',
      reason: 'success',
    });
  });

  it('returns null for absent / blank / malformed / non-object input', () => {
    expect(parseBuildEvent(undefined)).toBeNull();
    expect(parseBuildEvent(null)).toBeNull();
    expect(parseBuildEvent('   ')).toBeNull();
    expect(parseBuildEvent('{oops')).toBeNull();
    expect(parseBuildEvent('42')).toBeNull();
    expect(parseBuildEvent('"a string"')).toBeNull();
  });
});

describe('teardown-build: classifyTarget (which worktree may be removed)', () => {
  const OUTSIDE = '/opt/specbook'; // running from the main checkout — safe to remove a worktree

  it('REMOVES an orphaned build worktree strictly under the worktrees root', () => {
    expect(classifyTarget('/opt/specbook/.claude/worktrees/agent-dead', ROOT, OUTSIDE).action).toBe(
      'remove',
    );
  });

  it('REFUSES the main checkout and anything outside the worktrees root', () => {
    expect(classifyTarget('/opt/specbook', ROOT, OUTSIDE).action).toBe('refuse');
    expect(classifyTarget('/opt/specbook/apps/api', ROOT, OUTSIDE).action).toBe('refuse');
    expect(classifyTarget('/', ROOT, OUTSIDE).action).toBe('refuse');
    // A prefix-share sibling (…/worktrees-backup) is not inside the root.
    expect(classifyTarget('/opt/specbook/.claude/worktrees-backup/x', ROOT, OUTSIDE).action).toBe(
      'refuse',
    );
  });

  it('REFUSES to remove the worktree THIS process is running inside (no self-delete)', () => {
    const wt = '/opt/specbook/.claude/worktrees/agent-self';
    expect(classifyTarget(wt, ROOT, wt).action).toBe('refuse');
    // …including when cwd is a nested dir of the target worktree.
    expect(classifyTarget(wt, ROOT, `${wt}/apps/web`).action).toBe('refuse');
  });

  it('REFUSES when no target is given', () => {
    expect(classifyTarget('', ROOT, OUTSIDE).action).toBe('refuse');
  });
});

describe('teardown-build: classifyDb (which databases may be dropped)', () => {
  it('DROPS a throwaway sb_* database', () => {
    expect(classifyDb('sb_devstack_12345').action).toBe('drop');
    expect(classifyDb('sb_').action).toBe('drop');
  });

  it('KEEPS the real databases — valmatic* / specbook* are never dropped', () => {
    expect(classifyDb('valmatic').action).toBe('keep');
    expect(classifyDb('valmatic_test').action).toBe('keep');
    expect(classifyDb('specbook').action).toBe('keep');
    expect(classifyDb('specbook_prod').action).toBe('keep');
  });

  it('KEEPS anything outside the sb_ namespace, including sneaky prefixes', () => {
    expect(classifyDb('postgres').action).toBe('keep');
    expect(classifyDb('sbook').action).toBe('keep'); // no underscore boundary
    expect(classifyDb('xsb_evil').action).toBe('keep'); // sb_ not at the start
    expect(classifyDb('').action).toBe('keep');
    // defensive: non-string input is kept, never dropped.
    expect(classifyDb(null).action).toBe('keep');
  });
});
