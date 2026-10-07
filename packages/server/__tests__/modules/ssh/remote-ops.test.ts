import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * A Redis the app reaches by NAME must sit on the network where that name
 * resolves. `renderPlatformWiring` sends `REDIS_HOST=specbook-redis-<unit>`
 * for every cache that did not move, and Docker's embedded DNS answers that
 * name only on a user-defined network. An op that creates such a container off
 * `specbook-data` reports success and provisions cleanly; the failure surfaces
 * later and elsewhere, as `getaddrinfo EAI_AGAIN` inside the running app on
 * whichever route touches Redis first. That is exactly how it shipped once —
 * the wiring half was tested, the half that has to match it was not.
 */
describe('a co-located Redis lives where its DNS name resolves', () => {
  it.each(['data-plane-provision-unit', 'cache-provision-local'])(
    '%s attaches the Redis it creates to specbook-data',
    (name) => {
      const script = REMOTE_OPS[name as keyof typeof REMOTE_OPS];
      expect(script).toContain('docker run -d --name "specbook-redis-$unit"');
      expect(script).toContain('--network specbook-data');
    },
  );

  it('the co-located Redis publishes NO host port — nothing off the network dials it', () => {
    expect(REMOTE_OPS['cache-provision-local']).not.toMatch(/-p\s/);
  });

  it('a MOVED cache publishes a port instead, because the app dials it by address', () => {
    // The mirror image, and the reason these are two ops: a cache server need
    // not have specbook-data at all, and the wiring for it carries host:port.
    const script = REMOTE_OPS['cache-provision-unit'];
    expect(script).toContain('-p "$bind:$port:6379"');
    expect(script).not.toContain('--network');
  });

  it('both password-protected Redis ops refuse to start without one', () => {
    for (const name of ['cache-provision-local', 'cache-provision-unit'] as const) {
      expect(REMOTE_OPS[name]).toContain('--requirepass "$cache_pw"');
      expect(REMOTE_OPS[name]).toMatch(/missing password on stdin/);
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

/**
 * deploy-stack run for real, against stand-ins for docker, python3 and sleep.
 * The probe is the part that matters: each hostname has its own certificate,
 * so a deploy is only healthy when EVERY one of them answers.
 */
describe('deploy-stack probes every hostname', () => {
  const run = (domains: string[], failing: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-stack-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const stub = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub('docker', 'exit 0');
    stub('sleep', 'exit 0');
    // The probe is `python3 -c "<program naming https://<host>/health>"`.
    stub(
      'python3',
      `for bad in ${failing.map((d) => `'${d}'`).join(' ')}; do case "$2" in *"https://$bad/health"*) exit 1;; esac; done; exit 0`,
    );
    try {
      return spawnSync('bash', ['-s', '--', 'acme_production', dir, '21000', ...domains], {
        input: REMOTE_OPS['deploy-stack'],
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: dir },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reports each hostname healthy, main domain first', () => {
    const result = run(['admin.example.com', 'app.example.com']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('healthy on https://admin.example.com');
    expect(result.stdout).toContain('healthy on https://app.example.com');
  });

  /** One name answering must not hide another whose certificate never arrived. */
  it('fails and names the hostname that never answered', () => {
    const result = run(['admin.example.com', 'app.example.com'], ['app.example.com']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('healthy on https://admin.example.com');
    expect(result.stderr).toContain('https://app.example.com never answered /health');
  });

  it('still works with the single domain it always took', () => {
    const result = run(['admin.example.com']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('deploy-stack: healthy on https://admin.example.com');
  });

  it('refuses a hostname that is not a plain name, wherever it sits in the list', () => {
    const result = run(['admin.example.com', 'app.example.com;id']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid domain');
  });

  it('falls back to the published port when there is no hostname at all', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('healthy on :21000');
  });
});
