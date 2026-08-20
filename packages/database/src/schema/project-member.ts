import { pgTable, uuid, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { organization } from './organization';
import { project } from './project';
import { user } from './user';

/**
 * The per-project visibility ACL — the plane BELOW org membership. One row
 * (projectId × userId) means "this human MEMBER may SEE this project" and,
 * through it, the project's tasks and attachments. Deny-by-default: a MEMBER
 * with no rows sees no projects.
 *
 * OWNER/ADMIN and agent (MCP API-key) identities are NEVER gated by this
 * table — owners/admins see every project, and agents keep org-wide visibility
 * so the dispatch runner never goes blind. The enforcement lives in the
 * repository/service layer (see isProjectScopedIdentity in @pkg/contracts).
 *
 * This is specbook's OWN visibility ACL and is deliberately unrelated to GitHub
 * repo access: a grant here never grants a collaborator seat on the repository.
 * specbook only REMINDS about repo collaborators — it never grants them.
 *
 * `org_id` is denormalized from the owning project so every grant read stays
 * org-scoped without a join, the same discipline every other tenant query uses.
 */
export const projectMember = pgTable(
  'project_member',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Who granted the access — audit only; ON DELETE SET NULL so removing the
    // granter never revokes the grant.
    grantedBy: uuid('granted_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    // "Which projects can this member see" — the scoping predicate's lookup.
    index('project_member_org_user_idx').on(table.orgId, table.userId),
    index('project_member_project_idx').on(table.projectId),
  ],
);

export type ProjectMember = typeof projectMember.$inferSelect;
export type NewProjectMember = typeof projectMember.$inferInsert;
