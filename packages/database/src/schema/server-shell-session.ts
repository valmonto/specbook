import { pgTable, uuid, varchar, text, timestamp, integer, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { SHELL_SESSION_OUTCOMES } from '@pkg/contracts';
import { pk } from './helpers.js';
import { organization } from './organization.js';
import { server } from './server.js';
import { user } from './user.js';

/**
 * The audit trail of interactive shells on a server: one row per session —
 * opened, refused, or ended — and it must answer "who had a shell where, when"
 * long after the fact.
 *
 * This is the most privileged thing the product can do. specbook already runs
 * named scripts on these boxes, so the capability is not new to the SYSTEM;
 * what is new is a person driving it from a browser, typing anything. That is
 * worth a permanent record even when the server row is later deleted, so the
 * server link is SET NULL and its name and host are SNAPSHOTTED here — exactly
 * the shape data_access_audit uses, for the same reason.
 *
 * Append-only by convention, with one exception: the row is written on open
 * and closed out in place (endedAt / outcome / transcript), because a session
 * is one event with a duration rather than two unrelated ones. Nothing else
 * updates these rows and nothing deletes them.
 */
export const serverShellSession = pgTable(
  'server_shell_session',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id').references(() => server.id, { onDelete: 'set null' }),
    /** Snapshotted: the trail has to survive the server being deleted. */
    serverName: varchar('server_name', { length: 255 }).notNull(),
    serverHost: varchar('server_host', { length: 255 }).notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** Snapshotted for the same reason as the server's. */
    userName: varchar('user_name', { length: 255 }).notNull(),
    userEmail: varchar('user_email', { length: 255 }).notNull(),
    /** Values from @pkg/contracts SHELL_SESSION_OUTCOMES. */
    outcome: varchar('outcome', { length: 16 }).notNull(),
    /** A k.* refusal key, or a scrubbed error excerpt. */
    detail: text('detail'),
    /**
     * What the session printed, capped (see SHELL_TRANSCRIPT_MAX_BYTES). A
     * shell's whole value is that a person can do anything with it, so the
     * record of what they did is the point. Truncation is marked in-band
     * rather than silent.
     */
    transcript: text('transcript'),
    bytesIn: integer('bytes_in').notNull().default(0),
    bytesOut: integer('bytes_out').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the window would lapse on its own, recorded at open. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('server_shell_session_org_idx').on(table.orgId, table.openedAt),
    index('server_shell_session_server_idx').on(table.serverId, table.openedAt),
    check(
      'server_shell_session_outcome_check',
      sql.raw(`outcome IN (${SHELL_SESSION_OUTCOMES.map((v: string) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type ServerShellSession = typeof serverShellSession.$inferSelect;
export type NewServerShellSession = typeof serverShellSession.$inferInsert;
