import { describe, expect, it } from 'vitest';
import {
  appendDeployLog,
  LOG_TRUNCATION_MARKER,
  scrubDeployText,
} from '../../../src/modules/deploy/deploy-log.js';

describe('scrubDeployText', () => {
  it('removes registered literals and the x-access-token pattern anywhere', () => {
    const url = 'https://x-access-token:ghs_secret123@github.com/org/repo.git';
    const out = scrubDeployText(`cloning ${url} ... token x-access-token:ghs_other@host`, [url]);
    expect(out).not.toContain('ghs_secret123');
    expect(out).not.toContain('ghs_other');
    expect(out).toContain('<repo-url>');
    expect(out).toContain('x-access-token:***@');
  });

  it('empty literal list still scrubs the pattern; empty literals are ignored', () => {
    expect(scrubDeployText('x-access-token:abc@h', [''])).toBe('x-access-token:***@h');
  });

  it('strips ANSI escape sequences — colored docker output reads as plain text', () => {
    expect(scrubDeployText('\x1b[90mmuted\x1b[39m plain \x1b[1;32mbold-green\x1b[0m')).toBe(
      'muted plain bold-green',
    );
  });
});

describe('appendDeployLog', () => {
  it('plain append below the cap', () => {
    expect(appendDeployLog('a\n', 'b\n', 100)).toBe('a\nb\n');
    expect(appendDeployLog(null, 'first\n', 100)).toBe('first\n');
  });

  it('over the cap keeps the TAIL, cut on a line boundary, marker first', () => {
    const lines =
      Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(3, '0')}`).join('\n') + '\n';
    const out = appendDeployLog('', lines, 200);
    expect(out.startsWith(`${LOG_TRUNCATION_MARKER}\n`)).toBe(true);
    expect(out).toContain('line-049');
    expect(out).not.toContain('line-000');
    // no half-line at the seam: content after the marker starts at a line start
    const afterMarker = out.slice(out.indexOf('\n') + 1);
    expect(afterMarker.startsWith('line-')).toBe(true);
  });

  it('repeated truncation never stacks markers', () => {
    let log = '';
    for (let i = 0; i < 30; i++) {
      log = appendDeployLog(log, `chunk-${i} ${'x'.repeat(40)}\n`, 200);
    }
    expect(log.match(new RegExp(LOG_TRUNCATION_MARKER, 'g'))).toHaveLength(1);
    expect(log).toContain('chunk-29');
  });
});
