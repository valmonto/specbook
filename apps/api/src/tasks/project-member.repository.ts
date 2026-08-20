import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  organizationUser,
  projectMember,
  user,
  and,
  asc,
  eq,
  inArray,
} from '@pkg/database';
import type { OrganizationUserRole } from '@pkg/contracts';

export interface ProjectMemberRow {
  userId: string;
  projectId: string;
  name: string;
  email: string;
  orgRole: OrganizationUserRole;
  grantedAt: Date;
}

/**
 * The per-project visibility ACL — grant/revoke/list plus the assignment gate.
 * Every method is org-scoped (the org_id column, denormalized from the owning
 * project), matching every other tenant query. This layer sits BELOW org
 * membership: it says who among the org's members may SEE a given project.
 */
@Injectable()
export class ProjectMemberRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  /** Idempotent grant: a repeat grant is a no-op, not a duplicate-key error. */
  async grant(
    orgId: string,
    projectId: string,
    userId: string,
    grantedBy: string,
  ): Promise<void> {
    await this.dbClient.db
      .insert(projectMember)
      .values({ orgId, projectId, userId, grantedBy })
      .onConflictDoNothing();
  }

  async revoke(orgId: string, projectId: string, userId: string): Promise<boolean> {
    const rows = await this.dbClient.db
      .delete(projectMember)
      .where(
        and(
          eq(projectMember.orgId, orgId),
          eq(projectMember.projectId, projectId),
          eq(projectMember.userId, userId),
        ),
      )
      .returning({ userId: projectMember.userId });
    return rows.length > 0;
  }

  /** Is this user a member of the org at all — the precondition to granting them a project. */
  async isOrgMember(orgId: string, userId: string): Promise<boolean> {
    const rows = await this.dbClient.db
      .select({ userId: organizationUser.userId })
      .from(organizationUser)
      .where(and(eq(organizationUser.orgId, orgId), eq(organizationUser.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }

  /** The granted members of a project, with their identity + org role, oldest first. */
  async listForProject(orgId: string, projectId: string): Promise<ProjectMemberRow[]> {
    const rows = await this.dbClient.db
      .select({
        userId: projectMember.userId,
        projectId: projectMember.projectId,
        name: user.name,
        email: user.email,
        orgRole: organizationUser.role,
        grantedAt: projectMember.createdAt,
      })
      .from(projectMember)
      .innerJoin(user, eq(user.id, projectMember.userId))
      // The role read stays inside the tenant: the membership row is pinned to
      // the same org, so a stale grant for a since-removed member yields no role.
      .innerJoin(
        organizationUser,
        and(
          eq(organizationUser.userId, projectMember.userId),
          eq(organizationUser.orgId, orgId),
        ),
      )
      .where(and(eq(projectMember.orgId, orgId), eq(projectMember.projectId, projectId)))
      .orderBy(asc(projectMember.createdAt));

    return rows.map((r) => ({ ...r, orgRole: r.orgRole as OrganizationUserRole }));
  }

  /**
   * The assignment gate's question: may this user hold a task in this project?
   * True iff they can SEE the project — an org OWNER/ADMIN (all projects) or a
   * MEMBER carrying an explicit grant. A non-member of the org answers false.
   * One org-scoped query, so a foreign user id can never slip through.
   */
  async canAccessProject(orgId: string, projectId: string, userId: string): Promise<boolean> {
    // Org OWNER/ADMIN see every project — they are implicitly members of all.
    const elevated = await this.dbClient.db
      .select({ userId: organizationUser.userId })
      .from(organizationUser)
      .where(
        and(
          eq(organizationUser.orgId, orgId),
          eq(organizationUser.userId, userId),
          inArray(organizationUser.role, ['OWNER', 'ADMIN']),
        ),
      )
      .limit(1);
    if (elevated.length > 0) return true;

    // Otherwise a MEMBER needs an explicit grant on this project.
    const granted = await this.dbClient.db
      .select({ userId: projectMember.userId })
      .from(projectMember)
      .where(
        and(
          eq(projectMember.orgId, orgId),
          eq(projectMember.projectId, projectId),
          eq(projectMember.userId, userId),
        ),
      )
      .limit(1);
    return granted.length > 0;
  }
}
