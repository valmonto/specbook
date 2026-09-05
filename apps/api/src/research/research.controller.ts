import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  AcceptResearchRequestSchema,
  AppendResearchMessageRequestSchema,
  CreateResearchRequestSchema,
  CutTicketsRequestSchema,
  DeleteResearchRequestSchema,
  GetResearchRequestSchema,
  ListResearchMessagesRequestSchema,
  ListResearchRequestSchema,
  ReopenResearchRequestSchema,
  UpdateResearchRequestSchema,
  type AcceptResearchRequest,
  type AcceptResearchResponse,
  type ActiveUser as ActiveUserType,
  type AppendResearchMessageRequest,
  type AppendResearchMessageResponse,
  type CreateResearchRequest,
  type CreateResearchResponse,
  type CutTicketsRequest,
  type CutTicketsResponse,
  type DeleteResearchRequest,
  type DeleteResearchResponse,
  type GetResearchRequest,
  type GetResearchResponse,
  type ListResearchMessagesRequest,
  type ListResearchMessagesResponse,
  type ListResearchRequest,
  type ListResearchResponse,
  type ReopenResearchRequest,
  type ReopenResearchResponse,
  type UpdateResearchRequest,
  type UpdateResearchResponse,
} from '@pkg/contracts';
import { ResearchService } from './research.service.js';

/**
 * The human court for research: create, converse, accept/reopen, and cut
 * tickets. Every route is org-scoped via @ActiveUser — the request schema
 * never carries identity. Agents act through MCP tools (get_research,
 * list_research, append_research_message), which wrap the same service.
 */
@Controller('research')
export class ResearchController {
  constructor(private readonly researchService: ResearchService) {}

  @Get()
  @Permissions('research:read')
  async list(
    @ZodRequest(ListResearchRequestSchema) dto: ListResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListResearchResponse> {
    return this.researchService.list(activeUser, dto);
  }

  @Post()
  @Permissions('research:create')
  async create(
    @ZodRequest(CreateResearchRequestSchema) dto: CreateResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateResearchResponse> {
    return this.researchService.create(activeUser, dto);
  }

  @Get(':id')
  @Permissions('research:read')
  async getById(
    @ZodRequest(GetResearchRequestSchema) dto: GetResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetResearchResponse> {
    return this.researchService.getById(activeUser, dto.id);
  }

  @Patch(':id')
  @Permissions('research:update')
  async update(
    @ZodRequest(UpdateResearchRequestSchema) dto: UpdateResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateResearchResponse> {
    return this.researchService.update(activeUser, dto);
  }

  @Get(':id/messages')
  @Permissions('research:read')
  async listMessages(
    @ZodRequest(ListResearchMessagesRequestSchema) dto: ListResearchMessagesRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListResearchMessagesResponse> {
    return this.researchService.listMessages(activeUser, dto);
  }

  @Post(':id/messages')
  @Permissions('research:update')
  async appendMessage(
    @ZodRequest(AppendResearchMessageRequestSchema) dto: AppendResearchMessageRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<AppendResearchMessageResponse> {
    return this.researchService.appendMessage(activeUser, dto);
  }

  @Post(':id/accept')
  @Permissions('research:accept')
  async accept(
    @ZodRequest(AcceptResearchRequestSchema) dto: AcceptResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<AcceptResearchResponse> {
    return this.researchService.accept(activeUser, dto);
  }

  // Reopen is human-only by design — no MCP tool wraps it. It rides the
  // accept axis (un-finalizing a document), so it shares research:accept.
  @Post(':id/reopen')
  @Permissions('research:accept')
  async reopen(
    @ZodRequest(ReopenResearchRequestSchema) dto: ReopenResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ReopenResearchResponse> {
    return this.researchService.reopen(activeUser, dto);
  }

  // Cutting tickets creates draft TASKS — gated by task:create, not a
  // research permission, because the work product is a task.
  @Post(':id/cut-tickets')
  @Permissions('task:create')
  async cutTickets(
    @ZodRequest(CutTicketsRequestSchema) dto: CutTicketsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CutTicketsResponse> {
    return this.researchService.cutTickets(activeUser, dto);
  }

  @Delete(':id')
  @Permissions('research:delete')
  async delete(
    @ZodRequest(DeleteResearchRequestSchema) dto: DeleteResearchRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeleteResearchResponse> {
    await this.researchService.delete(activeUser, dto.id);
    return {};
  }
}
