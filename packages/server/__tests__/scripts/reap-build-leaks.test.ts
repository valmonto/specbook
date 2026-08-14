import { describe, expect, it } from 'vitest';

// The reaper is a plain .mjs tool in scripts/; we import its PURE discriminators
// directly (no /proc, no git, nothing destructive) and prove the one rule that
// keeps it from ever taking the live site down.
// @ts-expect-error — untyped .mjs tool imported for its exported pure functions.
import { classifyCwd, classifyWorktree } from '../../../../scripts/reap-build-leaks.mjs';

const ROOT = '/opt/specbook/.claude/worktrees';

describe('reap-build-leaks discriminator: classifyCwd', () => {
  it('KILLS a process whose cwd is strictly under the worktrees root', () => {
    expect(classifyCwd('/opt/specbook/.claude/worktrees/agent-abc', ROOT).action).toBe('kill');
    // …including nested boot dirs (a build stack booted from apps/web inside its worktree)
    expect(classifyCwd('/opt/specbook/.claude/worktrees/agent-abc/apps/web', ROOT).action).toBe('kill');
    expect(classifyCwd('/opt/specbook/.claude/worktrees/agent-abc/apps/api', ROOT).action).toBe('kill');
  });

  it('KEEPS the live main-checkout processes (:3000 api, :5173 web) — never killed', () => {
    // These are the LIVE specbook.valmonto.com dev processes. Their cwds are
    // siblings of the worktrees root, never inside it.
    expect(classifyCwd('/opt/specbook/apps/api', ROOT).action).toBe('keep');
    expect(classifyCwd('/opt/specbook/apps/web', ROOT).action).toBe('keep');
    expect(classifyCwd('/opt/specbook', ROOT).action).toBe('keep');
  });

  it('KEEPS the worktrees root itself and anything outside it', () => {
    expect(classifyCwd('/opt/specbook/.claude/worktrees', ROOT).action).toBe('keep');
    expect(classifyCwd('/', ROOT).action).toBe('keep');
    expect(classifyCwd('/var/lib/docker/whatever', ROOT).action).toBe('keep'); // object storage :9000 lives here
    // A different repo's worktrees dir must not match ours.
    expect(classifyCwd('/home/other/.claude/worktrees/agent-x', ROOT).action).toBe('keep');
  });

  it('KEEPS when cwd is unreadable (null) rather than guessing kill', () => {
    expect(classifyCwd(null, ROOT).action).toBe('keep');
    expect(classifyCwd(undefined, ROOT).action).toBe('keep');
  });

  it('is not fooled by a prefix that is not a path boundary', () => {
    // `…/worktrees-backup` shares a string prefix with `…/worktrees` but is a
    // sibling, not inside it — must be kept.
    expect(classifyCwd('/opt/specbook/.claude/worktrees-backup/x', ROOT).action).toBe('keep');
  });
});

describe('reap-build-leaks discriminator: classifyWorktree', () => {
  it('REMOVES an orphaned worktree (under root, unlocked, no live process inside)', () => {
    const wt = { path: '/opt/specbook/.claude/worktrees/agent-dead', locked: false };
    expect(classifyWorktree(wt, ROOT, []).action).toBe('remove');
  });

  it('KEEPS a locked worktree — a lock means an active agent owns it', () => {
    const wt = { path: '/opt/specbook/.claude/worktrees/agent-live', locked: true };
    expect(classifyWorktree(wt, ROOT, []).action).toBe('keep');
  });

  it('KEEPS a worktree with a live process still cwd-inside it', () => {
    const wt = { path: '/opt/specbook/.claude/worktrees/agent-busy', locked: false };
    const liveCwds = ['/opt/specbook/.claude/worktrees/agent-busy/apps/api'];
    expect(classifyWorktree(wt, ROOT, liveCwds).action).toBe('keep');
  });

  it('KEEPS the main checkout worktree (not under the worktrees root)', () => {
    const wt = { path: '/opt/specbook', locked: false };
    expect(classifyWorktree(wt, ROOT, []).action).toBe('keep');
  });
});
