import { z } from 'zod';
import { OrganizationUserRoleSchema } from './organization.schema.js';

/**
 * The per-project visibility ACL, over the wire. A grant means a human MEMBER
 * may SEE the project (and its tasks/attachments). OWNER/ADMIN and agents are
 * never gated by it — see isProjectScopedIdentity.
 *
 * This is specbook's OWN visibility plane; it says nothing about GitHub repo
 * access. Repo-bound projects surface a REMINDER to add the person as a repo
 * collaborator — specbook reflects that need, it never grants it.
 */

// --- A granted member (the list row) ---
export const ProjectMemberSchema = z.object({
  userId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  /** The member's ORG role — owners/admins are shown as "all projects". */
  orgRole: OrganizationUserRoleSchema,
  grantedAt: z.string(),
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

/**
 * The GitHub-collaborator reminder for a repo-bound project. Null when the
 * project is unbound. Reflect-only: specbook never grants the seat.
 */
export const ProjectAccessGithubReminderSchema = z.object({
  repoFullName: z.string(),
});
export type ProjectAccessGithubReminder = z.infer<typeof ProjectAccessGithubReminderSchema>;

/** The shared read model both list and grant/revoke return. */
export const ProjectMembersViewSchema = z.object({
  data: z.array(ProjectMemberSchema),
  githubReminder: ProjectAccessGithubReminderSchema.nullable(),
});
export type ProjectMembersView = z.infer<typeof ProjectMembersViewSchema>;

// --- GET /projects/:id/members ---
export const ListProjectMembersRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const ListProjectMembersResponseSchema = ProjectMembersViewSchema;
export type ListProjectMembersRequest = z.infer<typeof ListProjectMembersRequestSchema>;
export type ListProjectMembersResponse = z.infer<typeof ListProjectMembersResponseSchema>;

// --- POST /projects/:id/members  { userId } ---
export const GrantProjectAccessRequestSchema = z
  .object({ id: z.string().uuid(), userId: z.string().uuid() })
  .strict();
export const GrantProjectAccessResponseSchema = ProjectMembersViewSchema;
export type GrantProjectAccessRequest = z.infer<typeof GrantProjectAccessRequestSchema>;
export type GrantProjectAccessResponse = z.infer<typeof GrantProjectAccessResponseSchema>;

// --- DELETE /projects/:id/members/:userId ---
export const RevokeProjectAccessRequestSchema = z
  .object({ id: z.string().uuid(), userId: z.string().uuid() })
  .strict();
export const RevokeProjectAccessResponseSchema = ProjectMembersViewSchema;
export type RevokeProjectAccessRequest = z.infer<typeof RevokeProjectAccessRequestSchema>;
export type RevokeProjectAccessResponse = z.infer<typeof RevokeProjectAccessResponseSchema>;
