import { BadRequestException } from '@nestjs/common';
import { SHELL_SESSION_MAX_CONCURRENT, SHELL_TRANSCRIPT_MAX_BYTES } from '@pkg/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerShellService, capTranscript } from '@/servers/server-shell.service.js';
import type { ServerShellRepository } from '@/servers/server-shell.repository.js';

const OWNER = {
  userId: 'u1',
  orgId: 'org1',
  orgRole: 'OWNER',
  systemRole: 'ADMIN',
} as never;

function fakeRepo() {
  return {
    findServer: vi.fn().mockResolvedValue({
      id: 'srv1',
      name: 'build',
      host: '10.0.0.1',
      orgId: 'org1',
    }),
    record: vi.fn().mockResolvedValue('session-1'),
    close: vi.fn().mockResolvedValue(undefined),
    listForServer: vi.fn().mockResolvedValue([]),
  } as unknown as ServerShellRepository & {
    findServer: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

describe('ServerShellService tickets', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let service: ServerShellService;

  beforeEach(() => {
    repo = fakeRepo();
    service = new ServerShellService(repo);
  });

  /**
   * The ticket IS the socket's authentication. If it were replayable, a
   * leaked URL would be a reusable shell — so single-use is the property that
   * matters, not merely that redeeming works once.
   */
  it('redeems a ticket exactly once', async () => {
    const { ticket } = await service.issue(OWNER, 'srv1');

    expect(service.redeem(ticket)).not.toBeNull();
    expect(service.redeem(ticket)).toBeNull();
  });

  it('refuses an unknown ticket', () => {
    expect(service.redeem('not-a-real-ticket')).toBeNull();
  });

  /** An expired ticket must be as good as no ticket, even if never redeemed. */
  it('refuses a ticket whose window has already lapsed', async () => {
    vi.useFakeTimers();
    try {
      const { ticket } = await service.issue(OWNER, 'srv1');
      vi.setSystemTime(new Date(Date.now() + 60 * 60_000));
      expect(service.redeem(ticket)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A refusal is exactly the event an audit exists to record. Writing rows
   * only for successful sessions would omit the interesting half.
   */
  it('writes an audit row when it refuses for too many open sessions', async () => {
    for (let i = 0; i < SHELL_SESSION_MAX_CONCURRENT; i++) {
      service.register({
        sessionId: `s${i}`,
        orgId: 'org1',
        serverId: 'srv1',
        expiresAt: new Date(Date.now() + 60_000),
        close: async () => undefined,
      });
    }

    await expect(service.issue(OWNER, 'srv1')).rejects.toBeInstanceOf(BadRequestException);

    const outcomes = repo.record.mock.calls.map((c) => (c[0] as { outcome: string }).outcome);
    expect(outcomes).toContain('refused');
  });

  /** Another org's open sessions must not count against this one. */
  it('counts concurrency per organization', async () => {
    for (let i = 0; i < SHELL_SESSION_MAX_CONCURRENT; i++) {
      service.register({
        sessionId: `other${i}`,
        orgId: 'org2',
        serverId: 'srv9',
        expiresAt: new Date(Date.now() + 60_000),
        close: async () => undefined,
      });
    }

    await expect(service.issue(OWNER, 'srv1')).resolves.toHaveProperty('ticket');
  });
});

describe('capTranscript', () => {
  it('leaves a transcript under the cap untouched', () => {
    expect(capTranscript('hello')).toBe('hello');
  });

  /**
   * Keeps the NEWEST output — the end of a session is what explains it — and
   * marks the drop in band, so the record never quietly claims to be whole.
   */
  it('keeps the tail and says how much it dropped', () => {
    const text = 'A'.repeat(100) + 'TAIL';
    const capped = capTranscript(text, 10);

    expect(capped).toContain('TAIL');
    expect(capped).toMatch(/transcript truncated: \d+ earlier bytes dropped/);
    expect(capped).not.toBe(text);
  });

  it('caps at the configured size', () => {
    const capped = capTranscript('x'.repeat(SHELL_TRANSCRIPT_MAX_BYTES + 5_000));
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThan(SHELL_TRANSCRIPT_MAX_BYTES + 200);
  });
});

describe('unredeemed tickets', () => {
  /**
   * A session that is issued and never connected — the tab was closed, the
   * socket never opened — would otherwise sit at `open` forever and the audit
   * would claim a live shell that does not exist.
   */
  it('closes the audit row when a ticket is never redeemed', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const service = new ServerShellService(repo);
      await service.issue(OWNER, 'srv1');

      await vi.advanceTimersByTimeAsync(60_000);

      expect(repo.close).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', outcome: 'expired' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /** A redeemed ticket is the socket's to close — the reaper must not touch it. */
  it('leaves a redeemed session alone', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo();
      const service = new ServerShellService(repo);
      const { ticket } = await service.issue(OWNER, 'srv1');
      service.redeem(ticket);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(repo.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
