// Pure comparator for scripts/licenses/versions.ts (plain JS so the unit tests
// can import it — see spdx.mjs).

/** `1.0.0-rc.3` → [1, 0, 0]; the prerelease tag is compared separately. */
function baseParts(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('-')[0].split('.').map(Number);
  return [major, minor, patch];
}

/**
 * @param {string} current
 * @param {string} latest
 * @returns {'major' | 'minor' | 'patch' | 'prerelease' | 'current'}
 */
export function compareVersions(current, latest) {
  if (current === latest) return 'current';
  const cur = baseParts(current);
  const lat = baseParts(latest);
  const order = cur[0] - lat[0] || cur[1] - lat[1] || cur[2] - lat[2];
  // Ahead of the `latest` tag (a pinned release candidate whose base version is
  // newer than the stable line, e.g. drizzle 1.0.0-rc.3 vs latest 0.45.x):
  // nothing to update to. Reporting it as "prerelease available" was noise.
  if (order > 0) return 'current';
  // Same base, and one side carries a prerelease tag: the only move is
  // between a prerelease and its release, or between two prereleases.
  if (order === 0) return 'prerelease';
  if (latest.includes('-')) return 'prerelease';
  if (cur[0] !== lat[0]) return 'major';
  if (cur[1] !== lat[1]) return 'minor';
  return 'patch';
}
