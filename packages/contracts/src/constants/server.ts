/**
 * Server roles for the deploy platform: a box can build images, run apps,
 * and/or host the shared data plane. Values are data (varchar + CHECK in
 * the database); one server may hold several roles.
 */
export const SERVER_ROLES = ['build', 'app', 'data', 'runner'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

export const SERVER_STATUSES = [
  'unverified',
  'reachable',
  'unreachable',
  'fingerprint_mismatch',
] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];
