import { describe, expect, it } from 'vitest';
import {
  deriveCachePort,
  renderPlatformWiring,
  resolvePlacement,
  serverSatisfies,
  type PlacementServer,
} from '../../../src/modules/deploy/placement.js';

/**
 * The placement contract. The first suite is the regression the whole ticket
 * hangs on: NOTHING ALREADY DEPLOYED MAY CHANGE BEHAVIOUR — an environment
 * with NULL placement renders byte-identical wiring to the pre-placement code.
 */

const app: PlacementServer = {
  id: 'app',
  name: 'app-box',
  host: 'app.internal',
  roles: ['app', 'data'],
};
const db: PlacementServer = {
  id: 'db',
  name: 'pg-box',
  host: '192.168.122.20',
  roles: ['database'],
};
const cache: PlacementServer = {
  id: 'cache',
  name: 'redis-box',
  host: '192.168.122.30',
  roles: ['cache'],
};
const legacyOnly: PlacementServer = {
  id: 'legacy',
  name: 'old-box',
  host: 'old.internal',
  roles: ['data'],
};

const nullPlacement = {
  serverId: 'app',
  databaseServerId: null,
  cacheServerId: null,
  storageServerId: null,
  dataTransport: null,
};

describe('NULL placement — the legacy `data` path, unchanged', () => {
  it('resolves every role to the app server and reports nothing remote', () => {
    const p = resolvePlacement(nullPlacement, [app]);
    expect(p.database.server).toBe(app);
    expect(p.cache.server).toBe(app);
    expect(p.storage.server).toBe(app);
    expect(p.anyRemote).toBe(false);
    expect(p.transport).toBeNull();
  });

  it('renders EXACTLY the pre-placement wiring: container DNS, no host port, no password', () => {
    const p = resolvePlacement(nullPlacement, [app]);
    const wired = renderPlatformWiring({
      unit: 'proj_staging',
      placement: p,
      databasePassword: 'pw123',
      cachePassword: 'never-used',
    });
    // Byte-identical to what environment-provision.processor wrote before this change.
    expect(wired).toEqual({
      DATABASE_URL: 'postgresql://proj_staging:pw123@specbook-postgres:5432/proj_staging',
      REDIS_HOST: 'specbook-redis-proj_staging',
      REDIS_PORT: '6379',
    });
    expect(wired).not.toHaveProperty('REDIS_PASSWORD');
  });

  it('naming the app server itself as a placement is the same as NULL', () => {
    const p = resolvePlacement(
      { ...nullPlacement, databaseServerId: 'app', cacheServerId: 'app' },
      [app],
    );
    expect(p.anyRemote).toBe(false);
  });
});

describe('moved roles — only the moved value changes', () => {
  it('a remote database changes DATABASE_URL to a reachable host:port and leaves REDIS_HOST as container DNS', () => {
    const p = resolvePlacement(
      { ...nullPlacement, databaseServerId: 'db', dataTransport: 'private-network' },
      [app, db],
    );
    const wired = renderPlatformWiring({
      unit: 'proj_staging',
      placement: p,
      databasePassword: 'pw123',
      cachePassword: 'cpw',
    });
    expect(wired.DATABASE_URL).toBe(
      'postgresql://proj_staging:pw123@192.168.122.20:5432/proj_staging',
    );
    // The untouched role keeps its exact legacy value.
    expect(wired.REDIS_HOST).toBe('specbook-redis-proj_staging');
    expect(wired.REDIS_PORT).toBe('6379');
    expect(wired).not.toHaveProperty('REDIS_PASSWORD');
  });

  it('tls transport asks for sslmode=verify-full; private-network adds nothing on the wire', () => {
    const tls = resolvePlacement(
      { ...nullPlacement, databaseServerId: 'db', dataTransport: 'tls' },
      [app, db],
    );
    expect(
      renderPlatformWiring({ unit: 'u', placement: tls, databasePassword: 'p', cachePassword: 'c' })
        .DATABASE_URL,
    ).toBe('postgresql://u:p@192.168.122.20:5432/u?sslmode=verify-full');
  });

  it('a remote cache binds to the cache server host on a stable derived port with a password', () => {
    const p = resolvePlacement(
      { ...nullPlacement, cacheServerId: 'cache', dataTransport: 'private-network' },
      [app, cache],
    );
    const wired = renderPlatformWiring({
      unit: 'proj_staging',
      placement: p,
      databasePassword: 'pw123',
      cachePassword: 'cpw',
    });
    expect(wired.REDIS_HOST).toBe('192.168.122.30');
    expect(wired.REDIS_PORT).toBe(String(deriveCachePort('proj_staging')));
    expect(wired.REDIS_PASSWORD).toBe('cpw');
    // Database untouched.
    expect(wired.DATABASE_URL).toBe(
      'postgresql://proj_staging:pw123@specbook-postgres:5432/proj_staging',
    );
  });

  it('cache ports are stable, in [30000, 37999], and never 0.0.0.0-bound (the host is the server host)', () => {
    const port = deriveCachePort('proj_staging');
    expect(port).toBe(deriveCachePort('proj_staging'));
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(38000);
  });

  it('refuses to resolve a placement whose server was not loaded', () => {
    expect(() => resolvePlacement({ ...nullPlacement, databaseServerId: 'ghost' }, [app])).toThrow(
      /database server ghost not loaded/,
    );
  });
});

describe('serverSatisfies — the legacy role stays valid only where it already is', () => {
  it('the granular role satisfies its own placement, local or remote', () => {
    expect(serverSatisfies(db, 'database', true)).toBe(true);
    expect(serverSatisfies(cache, 'cache', true)).toBe(true);
  });

  it('the legacy `data` role covers database + cache on the app server itself', () => {
    expect(serverSatisfies(legacyOnly, 'database', false)).toBe(true);
    expect(serverSatisfies(legacyOnly, 'cache', false)).toBe(true);
    expect(serverSatisfies(legacyOnly, 'storage', false)).toBe(false);
  });

  it('a REMOTE placement must name the granular role — `data` does not spread to new boxes', () => {
    expect(serverSatisfies(legacyOnly, 'database', true)).toBe(false);
    expect(serverSatisfies(legacyOnly, 'cache', true)).toBe(false);
  });
});
