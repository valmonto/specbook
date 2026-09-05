/**
 * Server roles for the deploy platform: a box can build images, run apps,
 * and/or host the shared data plane. Values are data (varchar + CHECK in
 * the database); one server may hold several roles.
 */
export const SERVER_ROLES = [
  'build',
  'app',
  'data',
  'runner',
  'database',
  'cache',
  'storage',
] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

/**
 * `data` is the COMBINED legacy role: Postgres + Redis co-located on the app
 * server, wired over container DNS. It stays fully valid on existing servers
 * and keeps meaning exactly that; it is no longer offered when registering a
 * NEW server, so the fleet converges on the granular roles without a
 * migration. Granular roles place one capability each — an environment's
 * `databaseServerId` / `cacheServerId` / `storageServerId` point at them.
 */
export const LEGACY_SERVER_ROLES = ['data'] as const satisfies readonly ServerRole[];
export const REGISTERABLE_SERVER_ROLES = SERVER_ROLES.filter(
  (role) => !(LEGACY_SERVER_ROLES as readonly string[]).includes(role),
) as readonly Exclude<ServerRole, 'data'>[];

/** The three capabilities an environment can place on a server other than its app server. */
export const DATA_PLANE_ROLES = ['database', 'cache', 'storage'] as const;
export type DataPlaneRole = (typeof DATA_PLANE_ROLES)[number];

/**
 * How a MOVED data-plane role is reached from the app server. Cross-host
 * Postgres is either encrypted (`tls`, sslmode=verify-full) or explicitly
 * acknowledged as a trusted private network (`private-network`, e.g. two
 * guests on one host bridge or a cloud private network, firewalled to the
 * app host). Plain unencrypted over an unstated network is refused.
 */
export const DATA_TRANSPORTS = ['private-network', 'tls'] as const;
export type DataTransport = (typeof DATA_TRANSPORTS)[number];

export const SERVER_STATUSES = [
  'unverified',
  'reachable',
  'unreachable',
  'fingerprint_mismatch',
] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];
