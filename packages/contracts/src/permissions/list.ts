/**
 * All available permissions in the system.
 * Format: resource:action
 */
export const PERMISSIONS = [
  // Auth / self-service permissions (available to any authenticated user)
  'auth:read-self',
  'auth:change-password',
  'auth:logout',

  // Organization permissions
  'org:list',
  'org:read',
  'org:create',
  'org:update',
  'org:switch',
  'org:invite', // Invite a user into the active organization (owner/admin)

  // User management permissions
  'user:list',
  'user:read',
  'user:create',
  'user:update',
  'user:delete',
  'user:create-owner', // Special: create users with OWNER role
  'user:promote-owner', // Special: promote existing users to OWNER
  'user:remove-owner', // Special: remove users with OWNER role

  // Job permissions
  'job:create',

  // Notification permissions
  'notification:list',
  'notification:read',
  'notification:update',
  'notification:delete',

  // Settings permissions
  'settings:read',
  'settings:update',

  // Server permissions
  // Deliberately NOT folded into settings:update. That grants editing a server
  // ROW; this grants an interactive shell ON the server — a different order of
  // power, and the only permission in the catalogue that is OWNER-only.
  'server:shell',

  // Project permissions
  'project:list',
  'project:read',
  'project:create',
  'project:update',
  'project:delete',
  'project:grant-access', // Grant/revoke a member's per-project visibility (owner/admin)

  // Task permissions
  'task:list',
  'task:read',
  'task:create',
  'task:update',
  'task:delete',
  'task:transition',
  'task:merge', // Server-side PR merge of an approved task — writes to GitHub
  'task:comment',

  // Research permissions
  'research:read',
  'research:create',
  'research:update',
  'research:accept',
  'research:delete',

  // Attachment permissions
  'attachment:create',
  'attachment:list',
  'attachment:read',
  'attachment:delete',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
