import { describe, expect, it } from 'vitest';
import { renderPlatformWiring, resolvePlacement } from '../../../src/modules/deploy/placement.js';

const app = { id: 'a', name: 'apps', host: '198.244.200.168', port: 2203, roles: ['app'] };
const external = {
  id: 'd',
  name: 'ovh-staging-db',
  host: '198.244.200.168',
  port: 35427,
  mode: 'external',
  caCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  roles: ['database'],
};

const env = {
  serverId: 'a',
  databaseServerId: 'd',
  cacheServerId: null,
  storageServerId: null,
  dataTransport: null,
};

describe('wiring for an external database server', () => {
  const placement = resolvePlacement(env, [app, external]);
  const wired = renderPlatformWiring({
    unit: 'loupe_staging',
    placement,
    databasePassword: 'pw',
    cachePassword: 'cpw',
  });

  /**
   * A published external Postgres commonly sits on a non-default port. The
   * renderer used to hardcode 5432, which produces a connection string that is
   * silently unreachable — the worst kind, since everything else looks correct.
   */
  it("uses the server's own port, not 5432", () => {
    expect(wired.DATABASE_URL).toContain('@198.244.200.168:35427/loupe_staging');
    expect(wired.DATABASE_URL).not.toContain(':5432');
  });

  it('verifies the certificate — an external database is never unencrypted', () => {
    expect(wired.DATABASE_URL).toContain('sslmode=verify-full');
  });

  /**
   * verify-full needs the CA, and a CA cannot be carried in a connection URL:
   * postgres.js accepts it only as a JS option. So it travels as its own
   * variable, which @pkg/database reads.
   */
  it('ships the CA as its own variable, since a URL cannot carry one', () => {
    expect(wired.DATABASE_CA_CERT).toContain('BEGIN CERTIFICATE');
  });

  it('leaves the co-located cache exactly as it was', () => {
    expect(wired.REDIS_HOST).toBe('specbook-redis-loupe_staging');
    expect(wired.REDIS_PORT).toBe('6379');
  });
});

describe('wiring when nothing is placed externally', () => {
  it('is unchanged — container DNS, no ssl, no CA', () => {
    const placement = resolvePlacement(
      { ...env, databaseServerId: null },
      [{ ...app, roles: ['app', 'data'] }],
    );
    const wired = renderPlatformWiring({
      unit: 'loupe_staging',
      placement,
      databasePassword: 'pw',
      cachePassword: 'cpw',
    });
    expect(wired.DATABASE_URL).toBe('postgresql://loupe_staging:pw@specbook-postgres:5432/loupe_staging');
    expect(wired.DATABASE_CA_CERT).toBeUndefined();
  });
});
