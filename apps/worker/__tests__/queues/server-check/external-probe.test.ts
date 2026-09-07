import { describe, expect, it } from 'vitest';
import {
  buildSslOptions,
  CHECK_ERROR_MAX,
  describeCheckFailure,
  probeExternalDatabase,
} from '../../../src/queues/server-check/external-probe.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

/**
 * These assert the TLS options directly rather than through a live server.
 * The previous test connected to a closed port, so the handshake never ran and
 * a change that crashes on every real TLS connection passed it cleanly.
 */
describe('buildSslOptions', () => {
  it('never sets servername for an IP host — Node throws, and it throws fatally', () => {
    const ssl = buildSslOptions('198.244.200.168', CA);
    expect(ssl).not.toBe('require');
    if (ssl === 'require') return;
    expect(ssl).not.toHaveProperty('servername');
  });

  it('sets servername for a DNS host, where SNI is meaningful', () => {
    const ssl = buildSslOptions('db.staging.solmond.xyz', CA);
    if (ssl === 'require') throw new Error('expected verifying options');
    expect(ssl.servername).toBe('db.staging.solmond.xyz');
  });

  it('always pins identity checking to the host dialed, IP or name', () => {
    for (const host of ['198.244.200.168', 'db.staging.solmond.xyz']) {
      const ssl = buildSslOptions(host, CA);
      if (ssl === 'require') throw new Error('expected verifying options');
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(typeof ssl.checkServerIdentity).toBe('function');
    }
  });

  it('requires TLS but cannot verify the peer when no CA is stored', () => {
    expect(buildSslOptions('198.244.200.168', null)).toBe('require');
  });
});

describe('probeExternalDatabase', () => {
  /**
   * A failure must be a RESULT, never a throw: the processor turns it into a
   * status, and an escaping error fails the job instead of marking the server.
   */
  it('returns a failure result rather than throwing when nothing answers', async () => {
    const result = await probeExternalDatabase({
      host: '127.0.0.1',
      port: 1,
      user: 'specbook_provisioner',
      password: 'irrelevant',
      caCert: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe('string');
  }, 20_000);
});

describe('describeCheckFailure', () => {
  it('keeps the far end\'s own words — that is the whole point of storing it', () => {
    expect(describeCheckFailure('permission denied for database "postgres"')).toBe(
      'permission denied for database "postgres"',
    );
  });

  it('flattens multi-line reasons so a row can render one', () => {
    expect(describeCheckFailure('connect failed\n  at Socket.secure\n  at process')).toBe(
      'connect failed at Socket.secure at process',
    );
  });

  it('caps length rather than letting a stack trace into the column', () => {
    const out = describeCheckFailure('x'.repeat(CHECK_ERROR_MAX * 2));
    expect(out.length).toBe(CHECK_ERROR_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('says something rather than nothing when the reason is missing', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(describeCheckFailure(empty)).toBe('check failed for an unreported reason');
    }
  });
});
