// Pure SPDX helpers for scripts/licenses/check.ts — kept in plain JS so the
// unit tests in packages/server/__tests__/scripts can import them the way they
// import the other script modules (a .ts file outside the package's rootDir
// cannot be imported by tsc).

/**
 * SPDX expressions may arrive wrapped in parentheses — "(Apache-2.0 AND MIT)"
 * and "Apache-2.0 AND MIT" are the same policy decision. Strip ONE outer pair
 * so the allow list is written once, without the parenthesised twin.
 * @param {string} license
 * @returns {string}
 */
export function normalizeLicense(license) {
  const trimmed = license.trim();
  return /^\(.*\)$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * A compound SPDX expression is evaluated, not string-matched: "A OR B" is
 * allowed when we may pick an allowed side; "A AND B" only when every side is
 * allowed. One operator level is enough for npm.
 * @param {string} expr  lower-cased, normalized expression
 * @param {Set<string>} allowed  lower-cased allow list
 * @returns {boolean}
 */
export function expressionAllowed(expr, allowed) {
  const orParts = expr.split(/\s+or\s+/);
  if (orParts.length > 1) return orParts.some((part) => expressionAllowed(part.trim(), allowed));
  const andParts = expr.split(/\s+and\s+/);
  if (andParts.length > 1) return andParts.every((part) => expressionAllowed(part.trim(), allowed));
  return allowed.has(expr);
}
