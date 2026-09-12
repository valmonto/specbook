import { MCP_DATA_PLANE_LIMITS } from '@pkg/contracts';
import { describe, expect, it } from 'vitest';
import { capLogText, logLineCount, logOpArgs } from '@/environments/app-logs.js';

/**
 * The bounds on a log read, which are the whole reason this is a named op and
 * not a shell. Both callers — the human route and `data_plane_logs` — go
 * through these, so a cap that only held on one path would be no cap at all.
 */
describe('log line count', () => {
  it('defaults when the caller asks for nothing', () => {
    expect(logLineCount(undefined)).toBe(MCP_DATA_PLANE_LIMITS.logsDefaultLines);
  });

  it('clamps an over-large request instead of refusing it', () => {
    expect(logLineCount(999_999)).toBe(MCP_DATA_PLANE_LIMITS.logsMaxLines);
  });

  it('refuses to go below one line', () => {
    expect(logLineCount(0)).toBe(1);
    expect(logLineCount(-40)).toBe(1);
  });
});

describe('op arguments', () => {
  it('passes an empty service through as "all services", not as a filter', () => {
    const [dir, unit, service, lines] = logOpArgs('/srv/app', 'unit_a', {});
    expect([dir, unit, service]).toEqual(['/srv/app', 'unit_a', '']);
    expect(lines).toBe(String(MCP_DATA_PLANE_LIMITS.logsDefaultLines));
  });

  it('carries a named service and a clamped line count', () => {
    expect(logOpArgs('/srv/app', 'unit_a', { service: 'api', lines: 10 })).toEqual([
      '/srv/app',
      'unit_a',
      'api',
      '10',
    ]);
  });
});

/**
 * A line cap does not bound bytes: one stack trace can be longer than the
 * whole tail it arrived in. And the useful end of a log is the bottom, so a
 * naive head-truncation would keep exactly the part nobody wants.
 */
describe('byte cap', () => {
  const max = MCP_DATA_PLANE_LIMITS.logsMaxBytes;

  it('leaves a small log completely alone', () => {
    const out = capLogText('a few lines\nof output\n', 'api', 200);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe('a few lines\nof output\n');
    expect(out.service).toBe('api');
  });

  it('keeps the NEWEST end and marks the cut in-band', () => {
    const text = 'x'.repeat(max) + 'THE-INTERESTING-PART';
    const out = capLogText(text, '', 200);

    expect(out.truncated).toBe(true);
    expect(out.text).toContain('THE-INTERESTING-PART');
    expect(out.text).toContain('earlier output dropped');
    // The cap is a real bound: the marker counts against it, so output just
    // over the limit cannot come back larger than it went in.
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(max);
  });

  it('reports "all" when no service was named, so the caller knows what it got', () => {
    expect(capLogText('', '', 50).service).toBe('all');
  });

  it('measures BYTES, not characters — multi-byte output must not slip past', () => {
    // '€' is three bytes: a length check would let ~3× the cap through.
    const text = '€'.repeat(max);
    expect(text.length).toBeLessThan(max * 2);
    expect(capLogText(text, 'api', 200).truncated).toBe(true);
  });
});
