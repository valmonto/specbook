import { isIP } from 'node:net';
import { checkServerIdentity as defaultCheckServerIdentity } from 'node:tls';
import postgres from 'postgres';

export interface ExternalProbeInput {
  host: string;
  port: number;
  user: string;
  password: string;
  /** PEM of the CA that signed the server cert; absent means TLS without verification. */
  caCert: string | null;
}

export type ExternalProbeResult =
  | { ok: true; canProvision: boolean }
  | { ok: false; reason: string };

/**
 * Reachability for an EXTERNAL data server. SSH is the wrong probe here — the
 * box runs no workload for specbook and may not expose sshd on this address at
 * all; checking it that way marks a perfectly good database unreachable.
 *
 * What actually matters is the thing specbook will do: open a TLS connection,
 * authenticate as the provisioning role, and confirm it can still create roles
 * and databases. A role can authenticate flawlessly and lack CREATEDB, or hold
 * CREATEROLE and still fail at `CREATE DATABASE ... OWNER` for want of SET —
 * so the privileges are part of the check, not an assumption.
 */
export type SslOptions =
  | 'require'
  | {
      ca: string;
      rejectUnauthorized: true;
      servername?: string;
      checkServerIdentity: (servername: string, cert: never) => Error | undefined;
    };

/**
 * TLS options for one probe. Exported because the rules below are the whole
 * risk surface and are far easier to assert directly than through a live
 * server — the bug this replaced shipped precisely because the test connected
 * to a closed port and never reached the TLS handshake.
 *
 * Two rules, and they pull in opposite directions:
 *
 *  - SNI cannot carry an IP literal. Node THROWS on `servername` set to an IP,
 *    and it throws from inside the driver's socket upgrade — where it is an
 *    uncaught exception that kills the process, not a rejected promise this
 *    function could turn into a result. So an IP host must not set it at all.
 *  - Identity must still be checked against the host actually dialed.
 *    Left alone, Node checks whatever `servername` says, defaulting to
 *    'localhost' over a socket the driver already opened — verifying a name
 *    nobody asked for.
 *
 * Passing checkServerIdentity explicitly satisfies both: the comparison is
 * pinned to `host` (Node matches an IP against the certificate's iPAddress
 * SANs, a DNS name against its dNSNames) whatever SNI ends up carrying.
 */
export function buildSslOptions(host: string, caCert: string | null): SslOptions {
  // No CA means TLS is still required, but nothing identifies who answered.
  if (!caCert) return 'require';
  return {
    ca: caCert,
    rejectUnauthorized: true,
    ...(isIP(host) ? {} : { servername: host }),
    checkServerIdentity: (_servername, cert) => defaultCheckServerIdentity(host, cert),
  };
}

export async function probeExternalDatabase(
  input: ExternalProbeInput,
): Promise<ExternalProbeResult> {
  const ssl = buildSslOptions(input.host, input.caCert);

  const sql = postgres({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: 'postgres',
    ssl: ssl as never,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 1,
    // A probe must never retry into a lockout, and its failure is the result.
    max_lifetime: 10,
    onnotice: () => {},
  });

  try {
    const [row] = await sql<{ can_provision: boolean }[]>`
      SELECT rolcreatedb AND rolcreaterole AS can_provision
      FROM pg_roles WHERE rolname = current_user
    `;
    return { ok: true, canProvision: Boolean(row?.can_provision) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'connection failed' };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
