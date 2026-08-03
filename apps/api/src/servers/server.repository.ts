import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  server,
  eq,
  and,
  count,
  desc,
  type NewServer,
  type Server,
} from '@pkg/database';

/** Every read and write is org-scoped: a server never leaks across organizations. */
@Injectable()
export class ServerRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  async create(data: NewServer): Promise<Server> {
    const [result] = await this.dbClient.db.insert(server).values(data).returning();
    return result!;
  }

  async findForOrg(
    orgId: string,
    opts: { skip: number; limit: number },
  ): Promise<{ data: Server[]; total: number }> {
    const whereClause = eq(server.orgId, orgId);
    const [data, totalResult] = await Promise.all([
      this.dbClient.db
        .select()
        .from(server)
        .where(whereClause)
        .orderBy(desc(server.createdAt))
        .offset(opts.skip)
        .limit(opts.limit),
      this.dbClient.db.select({ count: count() }).from(server).where(whereClause),
    ]);
    return { data, total: totalResult[0]?.count ?? 0 };
  }

  async findById(id: string, orgId: string): Promise<Server | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(server)
      .where(and(eq(server.id, id), eq(server.orgId, orgId)))
      .limit(1);
    return result ?? null;
  }

  /** Worker-side lookup for checks — id only; the worker has no session org. */
  async findByIdUnscoped(id: string): Promise<Server | null> {
    const [result] = await this.dbClient.db.select().from(server).where(eq(server.id, id)).limit(1);
    return result ?? null;
  }

  async findAllIds(): Promise<string[]> {
    const rows = await this.dbClient.db.select({ id: server.id }).from(server);
    return rows.map((r) => r.id);
  }

  async update(id: string, orgId: string, data: Partial<NewServer>): Promise<Server | null> {
    const [result] = await this.dbClient.db
      .update(server)
      .set(data)
      .where(and(eq(server.id, id), eq(server.orgId, orgId)))
      .returning();
    return result ?? null;
  }

  /** Check-result write, keyed by id alone — only the worker calls this. */
  async recordCheck(
    id: string,
    data: Pick<Partial<NewServer>, 'status' | 'hostFingerprint' | 'lastCheckedAt'>,
  ): Promise<void> {
    await this.dbClient.db.update(server).set(data).where(eq(server.id, id));
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(server)
      .where(and(eq(server.id, id), eq(server.orgId, orgId)))
      .returning({ id: server.id });
    return result.length > 0;
  }
}
