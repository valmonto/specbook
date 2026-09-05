import { describe, expect, it } from 'vitest';

// @ts-expect-error — untyped .mjs helpers imported for their exported functions.
import { expressionAllowed, normalizeLicense } from '../../../../scripts/licenses/spdx.mjs';
// @ts-expect-error — untyped .mjs helper, same as above.
import { compareVersions } from '../../../../scripts/licenses/version-compare.mjs';

// The license checker used to string-match the whole SPDX field, so a package
// declaring "(MIT OR CC0-1.0)" failed even though MIT is allowed. These are the
// compound shapes present in specbook's tree today.
describe('licenses/check — SPDX expressions', () => {
  const allowed = new Set(['mit', 'apache-2.0', 'isc', 'bsd-3-clause', 'cc0-1.0']);
  const ok = (expr: string) => expressionAllowed(normalizeLicense(expr).toLowerCase(), allowed);

  it('accepts a plain allowed identifier and rejects an unknown one', () => {
    expect(ok('MIT')).toBe(true);
    expect(ok('GPL-3.0')).toBe(false);
  });

  it('OR: allowed when any side is allowed (node-forge: BSD-3-Clause OR GPL-2.0)', () => {
    expect(ok('(BSD-3-Clause OR GPL-2.0)')).toBe(true);
    expect(ok('MIT OR Apache-2.0')).toBe(true);
    expect(ok('GPL-2.0 OR AGPL-3.0')).toBe(false);
  });

  it('AND: allowed only when every side is allowed (posthog-js: Apache-2.0 AND MIT)', () => {
    expect(ok('(Apache-2.0 AND MIT)')).toBe(true);
    expect(ok('MIT AND ISC')).toBe(true);
    expect(ok('MIT AND GPL-2.0')).toBe(false);
  });

  it('strips one pair of outer parentheses and nothing else', () => {
    expect(normalizeLicense('(MIT OR CC0-1.0)')).toBe('MIT OR CC0-1.0');
    expect(normalizeLicense('  MIT ')).toBe('MIT');
    expect(normalizeLicense('MIT')).toBe('MIT');
  });
});

describe('licenses/versions — prerelease ahead of latest', () => {
  it('a pinned RC whose base is newer than latest is current, not outdated', () => {
    expect(compareVersions('1.0.0-rc.3', '0.45.2')).toBe('current');
  });

  it('same base with a prerelease tag on either side is a prerelease move', () => {
    expect(compareVersions('1.0.0-rc.3', '1.0.0')).toBe('prerelease');
    expect(compareVersions('1.0.0', '1.0.0-rc.4')).toBe('prerelease');
  });

  it('classifies ordinary moves', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe('current');
    expect(compareVersions('1.2.3', '1.2.4')).toBe('patch');
    expect(compareVersions('1.2.3', '1.3.0')).toBe('minor');
    expect(compareVersions('1.2.3', '2.0.0')).toBe('major');
  });
});
