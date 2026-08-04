import { describe, expect, it } from 'vitest';
import { dataPlaneUnitName } from '../../../src/modules/ssh/unit-name';

/**
 * The unit name is spliced verbatim into SQL identifiers and container names
 * by the remote-op scripts, which accept exactly ^[a-z][a-z0-9_]{0,47}$ —
 * every output of this function must satisfy that, whatever the input.
 */
const SCRIPT_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

describe('dataPlaneUnitName', () => {
  it('produces the plain project_env shape for ordinary names', () => {
    expect(dataPlaneUnitName('acme', 'staging')).toBe('acme_staging');
    expect(dataPlaneUnitName('My App', 'production')).toBe('my_app_production');
  });

  it('always satisfies the remote-op identifier pattern, whatever the input', () => {
    const hostile = [
      ['Robert"); DROP TABLE projects;--', 'staging'],
      ['über-café', 'staging'],
      ['   ', 'staging'],
      ['1project', 'staging'],
      ['a'.repeat(300), 'production'],
      ['$(rm -rf /)', '`whoami`'],
      ['__init__', 'staging'],
    ] as const;
    for (const [project, env] of hostile) {
      expect(dataPlaneUnitName(project, env)).toMatch(SCRIPT_PATTERN);
    }
  });

  it('never exceeds 48 characters', () => {
    expect(dataPlaneUnitName('p'.repeat(100), 'production').length).toBeLessThanOrEqual(48);
  });

  it('is deterministic — the deprovision snapshot must match the provision run', () => {
    expect(dataPlaneUnitName('Acme App', 'staging')).toBe(dataPlaneUnitName('Acme App', 'staging'));
  });
});
