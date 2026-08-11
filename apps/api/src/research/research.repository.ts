import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  project,
  research,
  researchMessage,
  task,
  eq,
  and,
  count,
  asc,
  desc,
  gt,
  ilike,
  isNull,
  sql,
  type NewResearch,
  type NewResearchMessage,
  type Research,
  type ResearchMessage,
} from '@pkg/database';
import type { ResearchStatus } from '@pkg/contracts';

/** A decoded keyset cursor: the last (updated_at, id) a page returned. */
export interface ResearchCursor {
  updatedAt: Date;
  id: string;
}

export interface ListResearchFilter {
  cursor?: ResearchCursor;
  limit: number;
  projectId?: string;
  /** 'org' = org-level only (project_id IS NULL). */
  scope?: 'org';
  status?: ResearchStatus;
  q?: string;
}

export interface ListMessagesFilter {
  /** The last message id a page returned (messages page ascending). */
  cursor?: string;
  limit: number;
}

/**
 * Every read and write is org-scoped: research carries `org_id` directly, so a
 * document — and its messages — never leaks across organizations. A foreign
 * org id behaves exactly like a missing one.
 */
@Injectable()
export class ResearchRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  async create(data: NewResearch): Promise<Research> {
    const [result] = await this.dbClient.db.insert(research).values(data).returning();
    return result!;
  }

  async findById(id: string, orgId: string): Promise<Research | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(research)
      .where(and(eq(research.id, id), eq(research.orgId, orgId)))
      .limit(1);
    return result ?? null;
  }

  /**
   * Keyset (cursor) page, ordered (updated_at desc, id desc). Fetches one row
   * beyond the limit to know whether a next page exists — the extra row's
   * predecessor becomes `nextCursor`. New inserts land at the head (newest
   * updated_at) and never shift a cursor window, which is the whole point:
   * a scroll cannot skip or double-count.
   */
  async list(
    orgId: string,
    filter: ListResearchFilter,
  ): Promise<{ data: Research[]; nextCursor: ResearchCursor | null }> {
    const conditions = [eq(research.orgId, orgId)];
    if (filter.projectId) conditions.push(eq(research.projectId, filter.projectId));
    if (filter.scope === 'org') conditions.push(isNull(research.projectId));
    if (filter.status) conditions.push(eq(research.status, filter.status));
    if (filter.q) conditions.push(ilike(research.title, `%${filter.q}%`));
    if (filter.cursor) {
      // Row-value comparison walks the (updated_at desc, id desc) order.
      conditions.push(
        sql`(${research.updatedAt}, ${research.id}) < (${filter.cursor.updatedAt.toISOString()}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }

    const rows = await this.dbClient.db
      .select()
      .from(research)
      .where(and(...conditions))
      .orderBy(desc(research.updatedAt), desc(research.id))
      .limit(filter.limit + 1);

    const hasMore = rows.length > filter.limit;
    const data = hasMore ? rows.slice(0, filter.limit) : rows;
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
    return { data, nextCursor };
  }

  async update(id: string, orgId: string, data: Partial<NewResearch>): Promise<Research | null> {
    const [result] = await this.dbClient.db
      .update(research)
      .set(data)
      .where(and(eq(research.id, id), eq(research.orgId, orgId)))
      .returning();
    return result ?? null;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(research)
      .where(and(eq(research.id, id), eq(research.orgId, orgId)))
      .returning({ id: research.id });
    return result.length > 0;
  }

  // --- Messages ---

  async createMessage(data: NewResearchMessage): Promise<ResearchMessage> {
    const [result] = await this.dbClient.db.insert(researchMessage).values(data).returning();
    return result!;
  }

  /**
   * Keyset page of a document's messages, chronological (id asc — uuidv7 is
   * time-sorted). Org-scoped: the cursor and filter both pin org_id, so a
   * foreign org id reads nothing.
   */
  async listMessages(
    researchId: string,
    orgId: string,
    filter: ListMessagesFilter,
  ): Promise<{ data: ResearchMessage[]; nextCursor: string | null }> {
    const conditions = [
      eq(researchMessage.researchId, researchId),
      eq(researchMessage.orgId, orgId),
    ];
    if (filter.cursor) conditions.push(gt(researchMessage.id, filter.cursor));

    const rows = await this.dbClient.db
      .select()
      .from(researchMessage)
      .where(and(...conditions))
      .orderBy(asc(researchMessage.id))
      .limit(filter.limit + 1);

    const hasMore = rows.length > filter.limit;
    const data = hasMore ? rows.slice(0, filter.limit) : rows;
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? last.id : null;
    return { data, nextCursor };
  }

  /** The reverse lineage count: draft tickets cut from this document, org-scoped. */
  async countTasksCut(researchId: string, orgId: string): Promise<number> {
    const [row] = await this.dbClient.db
      .select({ n: count() })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(and(eq(task.sourceResearchId, researchId), eq(project.orgId, orgId)));
    return row?.n ?? 0;
  }
}
