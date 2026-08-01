import { Controller, Delete, Get, Patch, Post, Res } from '@nestjs/common';
import { OrgService } from './org.service';
import { ActiveUser, Permissions, ZodRequest, COOKIE_OPTIONS, COOKIE_TTL } from '@pkg/server';
import {
  ConnectGithubRequest,
  ConnectGithubRequestSchema,
  ConnectGithubResponse,
  CreateOrgRequest,
  CreateOrgRequestSchema,
  CreateOrgResponse,
  DisconnectGithubRequest,
  DisconnectGithubRequestSchema,
  DisconnectGithubResponse,
  GetGithubStatusRequest,
  GetGithubStatusRequestSchema,
  UpdateGithubSettingsRequest,
  UpdateGithubSettingsRequestSchema,
  UpdateGithubSettingsResponse,
  GetGithubStatusResponse,
  GetOrgByIdRequest,
  GetOrgByIdRequestSchema,
  GetOrgByIdResponse,
  ListOrgsRequest,
  ListOrgsRequestSchema,
  ListOrgsResponse,
  UpdateOrgRequest,
  UpdateOrgRequestSchema,
  UpdateOrgResponse,
  SwitchOrgRequest,
  SwitchOrgRequestSchema,
  SwitchOrgResponse,
  type ActiveUser as ActiveUserType,
} from '@pkg/contracts';
import type { FastifyReply } from 'fastify';

/**
 * The param name is load-bearing. `:orgId` puts a route under ActiveOrgGuard,
 * which forces it to equal the session's organization — so update and delete
 * only ever address the org the caller is switched into, and `@Permissions`
 * judges the right one by construction. `:id` (read) deliberately does not:
 * reading any organization you belong to is allowed from anywhere.
 */
@Controller('orgs')
export class OrgController {
  constructor(private readonly orgService: OrgService) {}

  @Get()
  @Permissions('org:list')
  async list(
    @ZodRequest(ListOrgsRequestSchema) dto: ListOrgsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListOrgsResponse> {
    return this.orgService.listOrgs(activeUser);
  }

  @Get(':id')
  @Permissions('org:read')
  async get(
    @ZodRequest(GetOrgByIdRequestSchema) dto: GetOrgByIdRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetOrgByIdResponse> {
    return this.orgService.getOrgById(activeUser, dto.id);
  }

  @Post()
  @Permissions('org:create')
  async create(
    @ZodRequest(CreateOrgRequestSchema) dto: CreateOrgRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateOrgResponse> {
    return this.orgService.createOrg(activeUser, dto);
  }

  @Patch(':orgId')
  @Permissions('org:update')
  async update(
    @ZodRequest(UpdateOrgRequestSchema) dto: UpdateOrgRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateOrgResponse> {
    return this.orgService.updateOrg(activeUser, dto);
  }

  // There is deliberately no DELETE here. Organization users, including
  // OWNERs, cannot delete organizations — that is a platform operation, on
  // /admin/orgs behind @SystemRoles(ADMIN). See AdminOrgController.

  // --- GitHub connection (first real use of the settings:* permissions) ---
  // `:orgId` on all three: ActiveOrgGuard pins them to the session's org, so
  // connect/disconnect can only ever administer the caller's own tenant.

  @Get(':orgId/github')
  @Permissions('settings:read')
  async githubStatus(
    @ZodRequest(GetGithubStatusRequestSchema) dto: GetGithubStatusRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetGithubStatusResponse> {
    return this.orgService.getGithubStatus(activeUser, dto.orgId);
  }

  @Post(':orgId/github')
  @Permissions('settings:update')
  async connectGithub(
    @ZodRequest(ConnectGithubRequestSchema) dto: ConnectGithubRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ConnectGithubResponse> {
    return this.orgService.connectGithub(activeUser, dto);
  }

  @Patch(':orgId/github')
  @Permissions('settings:update')
  async updateGithubSettings(
    @ZodRequest(UpdateGithubSettingsRequestSchema) dto: UpdateGithubSettingsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateGithubSettingsResponse> {
    return this.orgService.updateGithubSettings(activeUser, dto);
  }

  @Delete(':orgId/github')
  @Permissions('settings:update')
  async disconnectGithub(
    @ZodRequest(DisconnectGithubRequestSchema) dto: DisconnectGithubRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DisconnectGithubResponse> {
    await this.orgService.disconnectGithub(activeUser, dto.orgId);
    return {};
  }

  @Post('switch')
  @Permissions('org:switch')
  async switch(
    @ZodRequest(SwitchOrgRequestSchema) dto: SwitchOrgRequest,
    @ActiveUser() activeUser: ActiveUserType,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SwitchOrgResponse> {
    const { accessToken, refreshToken } = await this.orgService.switchOrg(activeUser, dto.orgId);

    reply.setCookie('accessToken', accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: COOKIE_TTL.ACCESS_TOKEN,
    });

    reply.setCookie('refreshToken', refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: COOKIE_TTL.REFRESH_TOKEN,
    });

    return {};
  }
}
