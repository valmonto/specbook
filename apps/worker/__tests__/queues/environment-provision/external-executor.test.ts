import { describe, expect, it } from 'vitest';
import {
  provisionUnitExternal,
  retireUnitExternal,
} from '../../../src/queues/environment-provision/external-executor.js';

const unreachable = {
  host: '127.0.0.1',
  port: 1,
  adminUser: 'specbook_provisioner',
  adminPassword: 'irrelevant',
  caCert: null,
};

/**
 * Unit names are derived server-side and already validated, but this is a
 * second entry point into SQL where identifiers cannot be parameterised. The
 * guard is re-applied here rather than trusted across the boundary, and it must
 * reject BEFORE any connection is attempted — a bad name should never reach the
 * wire at all.
 */
describe('unit name validation', () => {
  it.each([
    'DROP DATABASE x',
    'loupe"; DROP DATABASE postgres; --',
    'Loupe_Staging',
    '1loupe',
    'loupe-staging',
    '',
  ])('rejects %j without connecting', async (unit) => {
    await expect(provisionUnitExternal(unreachable, unit, 'pw')).rejects.toThrow(
      /invalid unit name/,
    );
    await expect(retireUnitExternal(unreachable, unit)).rejects.toThrow(/invalid unit name/);
  });

  it('accepts the shape dataPlaneUnitName produces', async () => {
    // Valid name, unreachable server: it gets past validation and fails on the
    // connection instead, which is how we know the guard let it through.
    await expect(provisionUnitExternal(unreachable, 'ket_app_staging', 'pw')).rejects.not.toThrow(
      /invalid unit name/,
    );
  }, 20_000);
});
