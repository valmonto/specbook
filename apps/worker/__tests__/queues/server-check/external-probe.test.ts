import { describe, expect, it } from 'vitest';
import { probeExternalDatabase } from '../../../src/queues/server-check/external-probe.js';

describe('probeExternalDatabase', () => {
  /**
   * The probe's contract is that a failure is a RESULT, never a thrown error —
   * the check processor turns it into a status, and an exception there would
   * fail the job instead of marking the server unreachable.
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

  /**
   * Regression: the TLS options are handed to tls.connect() over a socket
   * postgres.js already opened, so without an explicit servername Node checks
   * the certificate against 'localhost' and rejects every correctly-issued
   * cert with a message that blames the cert. Registering a real external
   * database failed exactly this way.
   */
  it('verifies the certificate against the host dialed, not localhost', async () => {
    const result = await probeExternalDatabase({
      host: '198.244.200.168',
      port: 1,
      user: 'specbook_provisioner',
      password: 'irrelevant',
      caCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('localhost');
  }, 20_000);
});
