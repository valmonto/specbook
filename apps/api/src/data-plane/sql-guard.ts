import { MCP_DATA_PLANE_LIMITS } from '@pkg/contracts';

/**
 * The FIRST wall in front of an agent's SQL: shape checks that are cheap and
 * loud. The second wall is the remote op itself (the unit's own role, a
 * read-only transaction, a statement timeout, a LIMIT wrapper), so this does
 * not have to be a SQL parser — it only has to refuse what is obviously not
 * "one bounded read".
 *
 * Rejected: empty input, more than one statement (a `;` anywhere but the very
 * end, comments that could hide one), anything not starting with SELECT /
 * WITH / EXPLAIN / SHOW / TABLE / VALUES, and statements over the size cap.
 * Anything that passes still runs read-only — this is not the security
 * boundary, it is the error message an agent gets in under a millisecond.
 */
const READ_STARTS = /^(select|with|explain|show|table|values)\b/i;

export type SqlGuardResult = { ok: true; statement: string } | { ok: false; reason: string };

export function guardReadOnlySql(input: string): SqlGuardResult {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  let statement = input.trim();
  if (!statement) return { ok: false, reason: 'empty' };
  if (statement.length > MCP_DATA_PLANE_LIMITS.sqlMaxLength)
    return { ok: false, reason: 'tooLong' };
  // Comments can smuggle a second statement past a naive check; refuse them.
  if (statement.includes('--') || statement.includes('/*')) {
    return { ok: false, reason: 'comments' };
  }
  // Exactly one statement: strip one trailing semicolon, then none may remain.
  if (statement.endsWith(';')) statement = statement.slice(0, -1).trimEnd();
  if (statement.includes(';')) return { ok: false, reason: 'multipleStatements' };
  if (!READ_STARTS.test(statement)) return { ok: false, reason: 'notARead' };
  // EXPLAIN ANALYZE would EXECUTE the statement; a read-only transaction still
  // refuses writes, but there is no reason to let it start.
  if (/^explain\s+(\(.*analyze|analyze)/i.test(statement)) return { ok: false, reason: 'analyze' };
  return { ok: true, statement };
}
