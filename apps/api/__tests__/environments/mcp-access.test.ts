import { describe, expect, it } from 'vitest';
import { effectiveMcpAccess } from '@/environments/mcp-access.js';

const now = new Date('2026-09-05T12:00:00Z');
const inTenMinutes = new Date('2026-09-05T12:10:00Z');
const tenMinutesAgo = new Date('2026-09-05T11:50:00Z');

/** Expiry is the clock's, not a column's: a lapsed grant IS 'none', everywhere. */
describe('effectiveMcpAccess', () => {
  it('defaults to none — rows without the columns, or with NULL until', () => {
    expect(effectiveMcpAccess({}, now).mode).toBe('none');
    expect(effectiveMcpAccess({ mcpAccess: 'read', mcpAccessUntil: null }, now).mode).toBe('none');
    expect(effectiveMcpAccess({ mcpAccess: 'none', mcpAccessUntil: inTenMinutes }, now).mode).toBe(
      'none',
    );
  });

  it('a live read window carries who/why/until', () => {
    expect(
      effectiveMcpAccess(
        {
          mcpAccess: 'read',
          mcpAccessUntil: inTenMinutes,
          mcpAccessBy: 'u1',
          mcpAccessReason: 'x',
        },
        now,
      ),
    ).toEqual({ mode: 'read', until: inTenMinutes, by: 'u1', reason: 'x' });
  });

  it('an expired window is indistinguishable from none — companions null too', () => {
    expect(
      effectiveMcpAccess(
        {
          mcpAccess: 'read',
          mcpAccessUntil: tenMinutesAgo,
          mcpAccessBy: 'u1',
          mcpAccessReason: 'x',
        },
        now,
      ),
    ).toEqual({ mode: 'none', until: null, by: null, reason: null });
    // The boundary itself is closed: until == now is expired.
    expect(effectiveMcpAccess({ mcpAccess: 'read', mcpAccessUntil: now }, now).mode).toBe('none');
  });

  it('write is honoured as a live mode when stored (a later grant surface may set it)', () => {
    expect(effectiveMcpAccess({ mcpAccess: 'write', mcpAccessUntil: inTenMinutes }, now).mode).toBe(
      'write',
    );
  });
});
