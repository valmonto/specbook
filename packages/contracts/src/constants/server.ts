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

/**
 * How specbook reaches a server. `specbook` boxes are agentless targets it
 * owns: it SSHes in and runs the workload as containers. An `external` server
 * already exists and specbook is only a CLIENT of it — no SSH, no key to
 * install, nothing provisioned on the box; it connects over TLS with a
 * credential the operator supplies and issues SQL. Because there is no SSH,
 * `host`/`port` on an external server mean the address APPLICATIONS connect
 * to, which is the only address that server has as far as specbook cares.
 */
export const SERVER_MODES = ['specbook', 'external'] as const;
export type ServerMode = (typeof SERVER_MODES)[number];

/**
 * Roles an EXTERNAL server may hold. Everything else (app, build, runner)
 * needs specbook to run something on the box, which needs SSH — so those are
 * managed-only by construction, not by convention.
 */
export const EXTERNAL_SERVER_ROLES = ['database', 'cache'] as const satisfies readonly ServerRole[];

export const SERVER_STATUSES = [
  'unverified',
  'reachable',
  'unreachable',
  'fingerprint_mismatch',
] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

/**
 * How a browser shell session on a server ended, for the audit trail.
 *
 * `refused` is a row too: an attempt to open a shell without the permission is
 * exactly the event an audit exists to record, and writing it only on success
 * would omit the interesting half.
 */
export const SHELL_SESSION_OUTCOMES = ['open', 'closed', 'expired', 'idle', 'error', 'refused'] as const;
export type ShellSessionOutcome = (typeof SHELL_SESSION_OUTCOMES)[number];

/**
 * How long a shell window lives before it closes itself, and how long it may
 * sit idle inside that. Both exist because a forgotten open terminal on a
 * production box is the failure mode here — modelled on the MCP read-window,
 * which a human opens deliberately and which lapses without anyone tidying up.
 */
export const SHELL_SESSION_TTL_MS = 30 * 60_000;
export const SHELL_SESSION_IDLE_MS = 10 * 60_000;

/** One org cannot hold more open shells than this at once. */
export const SHELL_SESSION_MAX_CONCURRENT = 3;

/**
 * The transcript is capped: a shell can print unbounded output (`yes`, a log
 * tail), and an audit row is not a place to discover that. Oldest output is
 * dropped and the truncation is marked in-band, so the record never silently
 * lies about being complete.
 */
export const SHELL_TRANSCRIPT_MAX_BYTES = 256 * 1024;
