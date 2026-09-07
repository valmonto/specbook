import { buildVerifiedTls } from '@pkg/database';
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
/**
 * TLS options for one probe. The rules that make this correct — never setting
 * `servername` for an IP host, and pinning `checkServerIdentity` to the host
 * dialed — live in @pkg/database, which is where the app's own connections get
 * them too. Kept in ONE place on purpose: a second copy is how one of them
 * drifts and reintroduces a crash that kills the process on boot.
 *
 * No CA means TLS is still required, but nothing identifies who answered.
 */
export function buildSslOptions(host: string, caCert: string | null) {
  return caCert ? buildVerifiedTls(host, caCert) : ('require' as const);
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

/** Longest failure reason stored on a server row. */
export const CHECK_ERROR_MAX = 300;

/**
 * Trim a failure reason to something a row can carry. Reasons come from the
 * far end — sshd, Node's TLS layer, Postgres — so they are useful but not
 * ours to trust: they can be long, multi-line, or absent. Nothing sensitive is
 * ever added here; the probe never puts the password in a message, and the
 * host and port it might mention are already on screen.
 */
export function describeCheckFailure(reason: string | undefined | null): string {
  const flat = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'check failed for an unreported reason';
  return flat.length > CHECK_ERROR_MAX ? `${flat.slice(0, CHECK_ERROR_MAX - 1)}…` : flat;
}
