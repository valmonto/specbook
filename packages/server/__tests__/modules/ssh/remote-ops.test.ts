import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REMOTE_OPS } from '../../../src/modules/ssh/remote-ops.js';

/**
 * These scripts are bash living inside TypeScript template literals, which is
 * the one place a backslash or a `${...}` can change meaning between reading
 * the file and running on the box. Nothing else parses them before sshd does:
 * typecheck sees a string, lint sees a string, and the first real reader is a
 * production server mid-deploy.
 */
describe('remote ops are valid bash', () => {
  it.each(Object.keys(REMOTE_OPS))('%s parses', (name) => {
    const script = REMOTE_OPS[name as keyof typeof REMOTE_OPS];
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(result.stderr, `${name} is not valid bash:\n${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  });

  it('every op refuses an unset argument rather than acting on an empty one', () => {
    // `rm -rf "$HOME/x/$name"` with an empty name is the failure this prevents.
    for (const [name, script] of Object.entries(REMOTE_OPS)) {
      if (!script.includes('${1')) continue;
      expect(script, `${name} reads $1 without a :? guard`).toMatch(/\$\{1:\?/);
    }
  });
});

/**
 * A runner host is the ONE place specbook installs OS packages — the trade is
 * deliberate (a dedicated agent VM has no customer stack to disturb), so the
 * boundary is worth pinning. If this starts failing because another op grew an
 * installer, that is the decision changing, not a broken test.
 */
describe('package installation stays scoped to runner hosts', () => {
  const MANAGERS = /\b(dnf|apt-get|apk|yum|zypper|pacman)\b/;

  it.each(Object.keys(REMOTE_OPS).filter((n) => n !== 'ensure-runner'))(
    '%s installs nothing',
    (name) => {
      expect(REMOTE_OPS[name as keyof typeof REMOTE_OPS]).not.toMatch(MANAGERS);
    },
  );

  it('ensure-runner installs only what a runner needs, and only when missing', () => {
    const script = REMOTE_OPS['ensure-runner'];
    expect(script).toMatch(/command -v node/);
    expect(script).toMatch(/command -v tmux/);
    // Guarded by the missing-list, never unconditional.
    expect(script).toMatch(/if \[ -n "\$missing" \]/);
    for (const mgr of ['dnf', 'apt-get', 'apk']) expect(script).toContain(mgr);
    // An unknown manager reports; it does not guess at a fourth syntax.
    expect(script).toMatch(/no dnf\/apt-get\/apk/);
  });

  it('refuses a node too old to install the CLI, instead of failing inside npm', () => {
    const script = REMOTE_OPS['ensure-runner'];
    expect(script).toMatch(/node_major/);
    expect(script).toMatch(/RUNNER_MISSING: node >= 20 to install the CLI/);
  });

  /**
   * Claude Code ships a native binary. Requiring node on a box that already
   * has `claude` would install a runtime nothing runs — and worse, the version
   * gate would refuse a working box over a node the CLI never touches.
   */
  it('needs node only when it has to install the CLI', () => {
    const script = REMOTE_OPS['ensure-runner'];
    const nodeCheck = script.indexOf('missing="$missing nodejs"');
    const claudeGuard = script.indexOf('if ! command -v claude');
    expect(claudeGuard).toBeGreaterThan(-1);
    expect(nodeCheck).toBeGreaterThan(claudeGuard);
    // tmux is unconditional; node is not.
    expect(script).toMatch(/command -v tmux[^\n]*\n\s*\n?\s*#/);
  });

  it('re-checks PATH after installing, rather than trusting the exit code', () => {
    expect(REMOTE_OPS['ensure-runner']).toMatch(/install reported success/);
  });
});
