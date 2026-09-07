import { createHash } from 'node:crypto';

/**
 * Data-plane PLACEMENT: which server hosts an environment's database, cache
 * and storage, and how each is wired into the app's env. Pure, so the worker
 * only transports and the whole decision is unit-tested.
 *
 * The contract this module protects: an environment with NULL placement
 * fields renders BYTE-IDENTICAL wiring to the pre-placement code — container
 * DNS on the app server's `specbook-data` network, nothing on a host port.
 * Only a MOVED role changes its value.
 */

/** The subset of a server row the placement logic needs. */
export interface PlacementServer {
  id: string;
  name: string;
  host: string;
  /**
   * For an EXTERNAL server this is the port applications dial, which is often
   * NOT 5432 — the address and port are the only ones such a server has, since
   * specbook never SSHes to it.
   */
  port: number;
  /** @pkg/contracts SERVER_MODES. Absent on older callers ⇒ 'specbook'. */
  mode?: string;
  /** PEM of the CA that signed its certificate; external + TLS only. */
  caCert?: string | null;
  roles: readonly string[];
}

/** The subset of an environment row the placement logic needs. */
export interface PlacementEnvironment {
  serverId: string;
  databaseServerId: string | null;
  cacheServerId: string | null;
  storageServerId: string | null;
  dataTransport: string | null;
}

export type PlacementRole = 'database' | 'cache' | 'storage';
export const PLACEMENT_ROLES: readonly PlacementRole[] = ['database', 'cache', 'storage'];

/** Where one role lives and whether it was moved off the app server. */
export interface ResolvedRole {
  role: PlacementRole;
  server: PlacementServer;
  /** True when the role runs on a server other than the app server. */
  remote: boolean;
}

export interface ResolvedPlacement {
  app: PlacementServer;
  database: ResolvedRole;
  cache: ResolvedRole;
  storage: ResolvedRole;
  /** Any role moved off the app server — the case that needs a transport. */
  anyRemote: boolean;
  /** The environment's declared transport for moved roles (null when nothing moved). */
  transport: string | null;
}

/**
 * Resolve each role to a server. A NULL placement (or one naming the app
 * server itself) falls through to the app server — the legacy `data` path;
 * a set one must be among `servers`.
 */
export function resolvePlacement(
  env: PlacementEnvironment,
  servers: readonly PlacementServer[],
): ResolvedPlacement {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const app = byId.get(env.serverId);
  if (!app) throw new Error(`placement: app server ${env.serverId} not loaded`);
  const pick = (role: PlacementRole, id: string | null): ResolvedRole => {
    if (!id || id === env.serverId) return { role, server: app, remote: false };
    const server = byId.get(id);
    if (!server) throw new Error(`placement: ${role} server ${id} not loaded`);
    return { role, server, remote: true };
  };
  const database = pick('database', env.databaseServerId);
  const cache = pick('cache', env.cacheServerId);
  const storage = pick('storage', env.storageServerId);
  const anyRemote = database.remote || cache.remote || storage.remote;
  return {
    app,
    database,
    cache,
    storage,
    anyRemote,
    transport: anyRemote ? env.dataTransport : null,
  };
}

/**
 * Does `server` hold what `role` needs? The legacy combined `data` role
 * satisfies database and cache ON THE APP SERVER ONLY — a remote placement
 * must name the granular role, so the fleet converges instead of spreading
 * the legacy role to new boxes.
 */
export function serverSatisfies(
  server: PlacementServer,
  role: PlacementRole,
  remote: boolean,
): boolean {
  if (server.roles.includes(role)) return true;
  if (!remote && role !== 'storage' && server.roles.includes('data')) return true;
  return false;
}

/**
 * Stable published port for a REMOTE cache unit: [30000, 37999], derived from
 * the unit name so re-provisioning never moves it. Disjoint from the app
 * proxy range (20000–27999) so both can share a box.
 */
export function deriveCachePort(unit: string): number {
  const digest = createHash('sha256').update(`cache:${unit}`).digest();
  return 30000 + (digest.readUInt16BE(0) % 8000);
}

export interface WiringInput {
  unit: string;
  placement: ResolvedPlacement;
  /** The unit's Postgres role password. */
  databasePassword: string;
  /** Used only when the cache is remote — the co-located Redis has no auth (unchanged). */
  cachePassword: string;
}

/**
 * The platform wiring the deploy renders into `.env`. For a NULL placement
 * this is exactly what the provisioner wrote before placement existed. A
 * moved role binds to the address the app server reaches it on — the
 * placement server's registered `host` — never 0.0.0.0; Postgres over `tls`
 * carries `sslmode=verify-full`, over a trusted private network nothing is
 * added (acknowledging the network is the whole point).
 */
export function renderPlatformWiring(input: WiringInput): Record<string, string> {
  const { unit, placement, databasePassword, cachePassword } = input;
  const wired: Record<string, string> = {};

  if (placement.database.remote) {
    const db = placement.database.server;
    // An external server is reached over TLS by definition — it is a database
    // on someone else's machine — so verification is not optional there.
    const external = db.mode === 'external';
    const ssl = external || placement.transport === 'tls' ? '?sslmode=verify-full' : '';
    // The port is the server's own, NOT a hardcoded 5432: a published external
    // Postgres commonly sits on a non-default port, and getting this wrong
    // produces a connection string that is silently unreachable.
    const port = external ? db.port : 5432;
    wired.DATABASE_URL = `postgresql://${unit}:${databasePassword}@${db.host}:${port}/${unit}${ssl}`;
    // verify-full needs the CA, and a CA cannot be carried in a connection
    // URL — postgres.js takes it as a JS option, so it travels as its own
    // variable and @pkg/database picks it up. See its README.
    if (external && db.caCert) wired.DATABASE_CA_CERT = db.caCert;
  } else {
    wired.DATABASE_URL = `postgresql://${unit}:${databasePassword}@specbook-postgres:5432/${unit}`;
  }

  if (placement.cache.remote) {
    wired.REDIS_HOST = placement.cache.server.host;
    wired.REDIS_PORT = String(deriveCachePort(unit));
    wired.REDIS_PASSWORD = cachePassword;
  } else {
    wired.REDIS_HOST = `specbook-redis-${unit}`;
    wired.REDIS_PORT = '6379';
  }

  return wired;
}
