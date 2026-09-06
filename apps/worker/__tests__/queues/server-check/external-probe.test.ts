import { describe, expect, it } from 'vitest';
import { probeExternalDatabase } from '../../../src/queues/server-check/external-probe.js';

/**
 * The probe's contract is that a failure is a RESULT, never a thrown error —
 * the check processor turns it into a status, and an exception there would
 * fail the job instead of marking the server unreachable. Pointing it at a
 * port with no listener exercises exactly that path without a live database.
 */
describe('probeExternalDatabase', () => {
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
