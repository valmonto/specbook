import type { OrganizationUserRole } from '../schemas/organization.schema';

/**
 * The project-visibility rule, in one Zod-free place so both the API
 * enforcement and the client render logic read the same truth.
 *
 * Only a HUMAN MEMBER is scoped to their granted projects (deny-by-default).
 * Everyone else sees every project in the org:
 *   - OWNER / ADMIN — full org visibility by role.
 *   - agent identities (MCP API keys, `isAgent`) — org-wide, so the dispatch
 *     runner never goes blind, WHATEVER org role the key's owner holds. This is
 *     why an agent whose owner is a MEMBER must still NOT be scoped.
 */
export function isProjectScopedIdentity(identity: {
  orgRole: OrganizationUserRole;
  isAgent?: boolean;
}): boolean {
  return identity.orgRole === 'MEMBER' && !identity.isAgent;
}
