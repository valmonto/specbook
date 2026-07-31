import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  project,
  eq,
  and,
  count,
  desc,
  type NewProject,
  type Project,
} from '@pkg/database';

/** Every read and write is org-scoped: a project never leaks across organizations. */
@Injectable()
export class ProjectRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  async create(data: NewProject): Promise<Project> {
    const [result] = await this.dbClient.db.insert(project).values(data).returning();
    return result!;
  }

  async findForOrg(
    orgId: string,
    opts: { skip: number; limit: number },
  ): Promise<{ data: Project[]; total: number }> {
    const whereClause = eq(project.orgId, orgId);

    const [data, totalResult] = await Promise.all([
      this.dbClient.db
        .select()
        .from(project)
        .where(whereClause)
        .orderBy(desc(project.createdAt))
        .offset(opts.skip)
        .limit(opts.limit),
      this.dbClient.db.select({ count: count() }).from(project).where(whereClause),
    ]);

    return { data, total: totalResult[0]?.count ?? 0 };
  }

  async findById(id: string, orgId: string): Promise<Project | null> {
    const [result] = await this.dbClient.db
      .select()
      .from(project)
      .where(and(eq(project.id, id), eq(project.orgId, orgId)))
      .limit(1);

    return result ?? null;
  }

  async update(id: string, orgId: string, data: Partial<NewProject>): Promise<Project | null> {
    const [result] = await this.dbClient.db
      .update(project)
      .set(data)
      .where(and(eq(project.id, id), eq(project.orgId, orgId)))
      .returning();

    return result ?? null;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const result = await this.dbClient.db
      .delete(project)
      .where(and(eq(project.id, id), eq(project.orgId, orgId)))
      .returning({ id: project.id });

    return result.length > 0;
  }
}
