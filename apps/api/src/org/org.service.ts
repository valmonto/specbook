import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectLogger, PinoLogger } from '@pkg/server';
import { IamService } from '@pkg/server';
import { k } from '@pkg/locales';
import type {
  AdminListOrgsRequest,
  AdminListOrgsResponse,
  ConnectGithubRequest,
  CreateOrgRequest,
  CreateOrgResponse,
  GetGithubStatusResponse,
  ListOrgsResponse,
  GetOrgByIdResponse,
  UpdateOrgRequest,
  UpdateOrgResponse,
  ActiveUser,
} from '@pkg/contracts';
import { GithubAppService } from '../github/github-app.service';
import { OrgRepository } from './org.repository';

@Injectable()
export class OrgService {
  constructor(
    private readonly orgRepository: OrgRepository,
    private readonly iamService: IamService,
    private readonly githubApp: GithubAppService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async listOrgs(activeUser: ActiveUser): Promise<ListOrgsResponse> {
    const orgs = await this.orgRepository.findOrgsForUser(activeUser.userId);

    return {
      data: orgs.map((org) => ({
        ...org,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      })),
      currentOrgId: activeUser.orgId,
    };
  }

  async getOrgById(activeUser: ActiveUser, orgId: string): Promise<GetOrgByIdResponse> {
    const org = await this.orgRepository.findOrgForUser(orgId, activeUser.userId);

    if (!org) {
      throw new NotFoundException(k.orgs.errors.notFound);
    }

    return {
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    };
  }

  async createOrg(activeUser: ActiveUser, dto: CreateOrgRequest): Promise<CreateOrgResponse> {
    const org = await this.orgRepository.createOrg({
      name: dto.name,
      ownerId: activeUser.userId,
    });

    this.logger.info({ orgId: org.id, userId: activeUser.userId }, 'Organization created');

    return {
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    };
  }

  /**
   * ActiveOrgGuard has already forced dto.orgId to equal the session's org, so
   * the membership and OWNER checks here judge the same organization the write
   * lands in. They stay as defence in depth, not as the primary gate.
   */
  async updateOrg(activeUser: ActiveUser, dto: UpdateOrgRequest): Promise<UpdateOrgResponse> {
    const org = await this.orgRepository.findOrgForUser(dto.orgId, activeUser.userId);

    if (!org) {
      throw new NotFoundException(k.orgs.errors.notFound);
    }

    if (org.role !== 'OWNER') {
      throw new ForbiddenException(k.orgs.errors.onlyOwnerCanUpdate);
    }

    const updated = await this.orgRepository.updateOrg(dto.orgId, { name: dto.name });

    if (!updated) {
      throw new InternalServerErrorException(k.common.errors.failedToRetrieveOrg);
    }

    this.logger.info({ orgId: dto.orgId }, 'Organization updated');

    return {
      ...updated,
      role: org.role,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Connection status + the granted repo list. ActiveOrgGuard has already
   * pinned orgId to the session's org; unconfigured and unconnected states
   * both degrade to a well-formed "nothing here" response so the UI renders
   * the same card in every deploy.
   */
  async getGithubStatus(activeUser: ActiveUser, orgId: string): Promise<GetGithubStatusResponse> {
    const empty: GetGithubStatusResponse = {
      configured: this.githubApp.enabled,
      installUrl: this.githubApp.enabled ? this.githubApp.installUrl() : null,
      connected: false,
      accountLogin: null,
      connectedAt: null,
      repositories: [],
    };

    if (!this.githubApp.enabled) return empty;

    const connection = await this.orgRepository.findGithubConnection(orgId);
    if (!connection) return empty;

    // A revoked installation (uninstalled on GitHub's side) surfaces as a
    // connected org with an empty repo list rather than a 5xx — the card
    // stays usable and Disconnect remains reachable to clean up.
    let repositories: GetGithubStatusResponse['repositories'] = [];
    try {
      repositories = await this.githubApp.listRepositories(connection.installationId);
    } catch (error) {
      this.logger.warn(
        { orgId, installationId: connection.installationId, err: error },
        'GitHub repo listing failed — returning connected status with no repos',
      );
    }

    return {
      ...empty,
      connected: true,
      accountLogin: connection.accountLogin,
      connectedAt: connection.connectedAt ? connection.connectedAt.toISOString() : null,
      repositories,
    };
  }

  /**
   * Store the installation GitHub redirected back with — after verifying with
   * GitHub that it exists and belongs to OUR App. Without that check, any
   * number typed into the callback URL would become the org's connection.
   */
  async connectGithub(
    activeUser: ActiveUser,
    dto: ConnectGithubRequest,
  ): Promise<GetGithubStatusResponse> {
    if (!this.githubApp.enabled) {
      throw new BadRequestException(k.orgs.github.errors.notConfigured);
    }

    const installation = await this.githubApp.getInstallation(dto.installationId);
    if (!installation) {
      throw new NotFoundException(k.orgs.github.errors.installationNotFound);
    }

    await this.orgRepository.setGithubConnection(dto.orgId, {
      installationId: installation.id,
      accountLogin: installation.accountLogin,
      connectedAt: new Date(),
    });

    this.logger.info(
      { orgId: dto.orgId, installationId: installation.id, account: installation.accountLogin },
      'GitHub installation connected',
    );

    return this.getGithubStatus(activeUser, dto.orgId);
  }

  /** Internal cross-module read (project repo binding); null = not connected. */
  async githubConnection(orgId: string) {
    return this.orgRepository.findGithubConnection(orgId);
  }

  async disconnectGithub(activeUser: ActiveUser, orgId: string): Promise<void> {
    await this.orgRepository.clearGithubConnection(orgId);
    this.logger.info({ orgId, userId: activeUser.userId }, 'GitHub installation disconnected');
  }

  /** Platform-admin view of every organization; no membership filter. */
  async adminListOrgs(dto: AdminListOrgsRequest): Promise<AdminListOrgsResponse> {
    const { data, total } = await this.orgRepository.findAllOrgs(dto);

    return {
      data: data.map((org) => ({
        ...org,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      })),
      meta: { total, skip: dto.skip, limit: dto.limit },
    };
  }

  /**
   * Deletes ANY organization — membership is deliberately not required, which
   * is exactly why the route sits behind @SystemRoles(ADMIN) rather than the
   * tenant permission table.
   *
   * The admin's own ACTIVE organization is refused rather than re-homed:
   * "switch first" keeps this path free of session surgery. Members of a
   * deleted organization are logged out on their next token refresh, and a
   * member whose only organization this was cannot log in afterwards — deleting
   * a customer's last workspace deprovisions that customer.
   */
  async adminDeleteOrg(activeUser: ActiveUser, orgId: string): Promise<void> {
    if (orgId === activeUser.orgId) {
      throw new ForbiddenException(k.orgs.errors.cannotDeleteActiveOrg);
    }

    const org = await this.orgRepository.findOrgById(orgId);

    if (!org) {
      throw new NotFoundException(k.orgs.errors.notFound);
    }

    await this.orgRepository.deleteOrg(orgId);

    this.logger.info(
      { orgId, orgName: org.name, deletedBy: activeUser.userId },
      'Organization deleted by platform admin',
    );
  }

  async switchOrg(
    activeUser: ActiveUser,
    orgId: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // Verify user has access to the target org
    const role = await this.orgRepository.getUserRoleInOrg(activeUser.userId, orgId);

    if (!role) {
      throw new ForbiddenException(k.orgs.errors.noAccess);
    }

    // Issue new tokens for the new org
    // systemRole is carried over unchanged: it belongs to the account, not the
    // organization, so switching organizations must not alter it.
    const tokens = await this.iamService.auth.issueTokens({
      userId: activeUser.userId,
      orgId,
      orgRole: role,
      systemRole: activeUser.systemRole,
    });

    this.logger.info(
      { userId: activeUser.userId, fromOrg: activeUser.orgId, toOrg: orgId },
      'User switched organization',
    );

    return tokens;
  }
}
