import { describe, expect, it } from 'vitest';
import { guardReadOnlySql } from '@/data-plane/sql-guard.js';

/**
 * The first wall: cheap shape checks that refuse anything that is obviously
 * not "one bounded read". The remote op is the second wall (unit role,
 * read-only transaction, timeout, LIMIT), so what matters here is that
 * nothing slips through by construction — comments, second statements,
 * writes dressed as reads.
 */
describe('guardReadOnlySql', () => {
  it('accepts a plain SELECT and strips one trailing semicolon', () => {
    expect(guardReadOnlySql('SELECT id, email FROM "user" ORDER BY id;')).toEqual({
      ok: true,
      statement: 'SELECT id, email FROM "user" ORDER BY id',
    });
  });

  it.each([
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'explain select 1',
    'SHOW search_path',
    'TABLE task',
    'VALUES (1)',
  ])('accepts read starts: %s', (sql) => {
    expect(guardReadOnlySql(sql).ok).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['DELETE FROM task', 'notARead'],
    ['UPDATE task SET title = 1', 'notARead'],
    ['INSERT INTO task VALUES (1)', 'notARead'],
    ['DROP TABLE task', 'notARead'],
    ['SELECT 1; DELETE FROM task', 'multipleStatements'],
    ['SELECT 1; -- hidden', 'comments'],
    ['SELECT /* x */ 1', 'comments'],
    ['EXPLAIN ANALYZE SELECT 1', 'analyze'],
    ['EXPLAIN (ANALYZE, BUFFERS) SELECT 1', 'analyze'],
    [`SELECT ${'x'.repeat(5000)}`, 'tooLong'],
  ])('refuses %j (%s)', (sql, reason) => {
    expect(guardReadOnlySql(sql)).toEqual({ ok: false, reason });
  });
});
