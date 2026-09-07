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
export async function probeExternalDatabase(
  input: ExternalProbeInput,
): Promise<ExternalProbeResult> {
  // verify-full when a CA is supplied: the server must present a certificate
  // this CA signed AND its identity must match the address we dialed. Without
  // a CA we still require TLS, but cannot verify who answered.
  //
  // `servername` is not optional here. postgres.js hands this object straight
  // to tls.connect() over a socket it already opened, so Node has no host of
  // its own to check against and falls back to 'localhost' — which fails
  // against every real certificate with a message that reads like the cert is
  // wrong ("Host: localhost. is not cert's CN: ..."). Naming the host we dialed
  // is what makes the identity check verify what we actually think it does.
  const ssl = input.caCert
    ? { ca: input.caCert, rejectUnauthorized: true, servername: input.host }
    : 'require';

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
