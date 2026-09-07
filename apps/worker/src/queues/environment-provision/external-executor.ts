import { buildVerifiedTls } from '@pkg/database';
import postgres, { type Sql } from 'postgres';

/**
 * Provisioning against a database server specbook does NOT own.
 *
 * The co-located path installs Postgres in a container and shells into it. An
 * external server already exists, runs no workload for us, and may expose no
 * sshd at all — so the only way in is the wire: connect as the stored
 * provisioning role over TLS and issue SQL.
 */
export interface ExternalTarget {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  caCert: string | null;
}

/**
 * Unit names are derived server-side and already validated, but this is a
 * second entry point into the same SQL and identifiers cannot be parameterised
 * — so the shape is re-checked here rather than trusted across a boundary.
 */
const UNIT = /^[a-z][a-z0-9_]{0,47}$/;
function assertUnit(unit: string): void {
  if (!UNIT.test(unit)) throw new Error(`invalid unit name: ${unit}`);
}

function connect(target: ExternalTarget): Sql {
  return postgres({
    host: target.host,
    port: target.port,
    user: target.adminUser,
    password: target.adminPassword,
    database: 'postgres',
    ssl: (target.caCert
      ? buildVerifiedTls(target.host, target.caCert)
      : 'require') as never,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 1,
    max_lifetime: 30,
    onnotice: () => {},
  });
}

/**
 * Create (or converge) one environment's isolated unit: a login role and a
 * database of the same name, owned by that role, with PUBLIC unable to connect.
 *
 * Idempotent by construction — CREATE-or-ALTER — so a re-provision of a healthy
 * environment rotates nothing and a half-failed one heals. That also means an
 * environment deleted and recreated finds its data still there.
 *
 * The REVOKE runs as the database's owner via SET ROLE: the provisioning
 * account owns the ROLE, not the database, and giving it ownership of every
 * tenant database instead would hand one credential the keys to all of them.
 */
export async function provisionUnitExternal(
  target: ExternalTarget,
  unit: string,
  password: string,
): Promise<void> {
  assertUnit(unit);
  const sql = connect(target);
  try {
    const [role] = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM pg_roles WHERE rolname = ${unit}
    `;
    await sql.unsafe(
      role
        ? `ALTER ROLE "${unit}" LOGIN PASSWORD '${password.replace(/'/g, "''")}'`
        : `CREATE ROLE "${unit}" LOGIN PASSWORD '${password.replace(/'/g, "''")}'`,
    );

    const [db] = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM pg_database WHERE datname = ${unit}
    `;
    if (!db) {
      // CREATE DATABASE cannot run inside a transaction block.
      await sql.unsafe(`CREATE DATABASE "${unit}" OWNER "${unit}"`);
    }
    // A fresh database is connectable by PUBLIC; without this every tenant on
    // a shared server can reach every other tenant's database.
    await sql.unsafe(
      `SET ROLE "${unit}"; REVOKE CONNECT ON DATABASE "${unit}" FROM PUBLIC; RESET ROLE;`,
    );
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Retire a unit when its environment goes away — WITHOUT destroying anything.
 *
 * On a co-located data plane the box is torn down anyway, so dropping is moot.
 * On a SHARED server the database outlives the environment, and dropping it is
 * a separate, irreversible act that nothing about deleting an environment
 * justifies. So the credential is disabled and the data is left.
 *
 * That makes an accidental deletion recoverable: recreating the environment
 * derives the same unit name, and provisioning above is CREATE-or-ALTER, so it
 * re-enables the role and the data is simply there.
 *
 * (It also avoids a mechanical trap: DROP ROLE fails while the role owns
 * objects, so a naive drop would error on the database it just created.)
 */
export async function retireUnitExternal(target: ExternalTarget, unit: string): Promise<void> {
  assertUnit(unit);
  const sql = connect(target);
  try {
    const [role] = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM pg_roles WHERE rolname = ${unit}
    `;
    if (role) await sql.unsafe(`ALTER ROLE "${unit}" NOLOGIN`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
