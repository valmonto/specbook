import { pgTable, uuid, varchar, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  INVITATION_STATUSES,
  ORGANIZATION_USER_ROLES,
  type InvitationStatus as InvitationStatusType,
  type OrganizationUserRole as OrganizationUserRoleType,
} from '@pkg/contracts';
import { pk } from './helpers.js';
import { organization } from './organization.js';
import { user } from './user.js';

/**
 * An invitation to join an organization by a copyable link. Domain-blind: the
 * row carries only who (`email`), which org (`orgId`), and what standing
 * (`role`) — no project/feature column ever rides here.
 *
 * The raw token is NEVER stored; only its sha256 hex (`tokenHash`, unique) — the
 * same at-rest pattern as `api_key`. `status`/`role` are varchar + CHECK, not
 * pgEnum (this package's rule); the value sets come from @pkg/contracts, the
 * same ones the Zod schemas validate. `invited_by` is SET NULL on user delete
 * so an accepted/pending invite outlives the inviter's account.
 */
export const invitation = pgTable(
  'invitation',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 32 }).$type<OrganizationUserRoleType>().notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    status: varchar('status', { length: 16 })
      .$type<InvitationStatusType>()
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    invitedBy: uuid('invited_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invitation_org_status_idx').on(table.orgId, table.status),
    index('invitation_email_idx').on(table.email),
    check(
      'invitation_role_check',
      sql.raw(`role IN (${ORGANIZATION_USER_ROLES.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'invitation_status_check',
      sql.raw(`status IN (${INVITATION_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type Invitation = typeof invitation.$inferSelect;
export type NewInvitation = typeof invitation.$inferInsert;
