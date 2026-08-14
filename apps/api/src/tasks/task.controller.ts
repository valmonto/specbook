import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  AddTaskCommentRequestSchema,
  AddTaskDependencyRequestSchema,
  CheckCriterionRequestSchema,
  ClearAssumptionRequestSchema,
  CreateTaskRequestSchema,
  DeleteTaskRequestSchema,
  GetTaskByIdRequestSchema,
  GetTaskPrRequestSchema,
  ListTaskAreasRequestSchema,
  ListTasksRequestSchema,
  MarkReadyRequestSchema,
  MergeTaskRequestSchema,
  RemoveTaskDependencyRequestSchema,
  TransitionTaskRequestSchema,
  UpdateTaskRequestSchema,
  type ActiveUser as ActiveUserType,
  type AddTaskCommentRequest,
  type AddTaskCommentResponse,
  type AddTaskDependencyRequest,
  type AddTaskDependencyResponse,
  type CheckCriterionRequest,
  type CheckCriterionResponse,
  type ClearAssumptionRequest,
  type ClearAssumptionResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type DeleteTaskRequest,
  type DeleteTaskResponse,
  type GetTaskByIdRequest,
  type GetTaskByIdResponse,
  type GetTaskPrRequest,
  type GetTaskPrResponse,
  type ListTaskAreasRequest,
  type ListTaskAreasResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type MarkReadyRequest,
  type MarkReadyResponse,
  type MergeTaskRequest,
  type MergeTaskResponse,
  type RemoveTaskDependencyRequest,
  type RemoveTaskDependencyResponse,
  type TransitionTaskRequest,
  type TransitionTaskResponse,
  type UpdateTaskRequest,
  type UpdateTaskResponse,
} from '@pkg/contracts';
import { TaskService } from './task.service';

/**
 * The human-court surface: every route passes actor 'user' to the service,
 * so the HUMAN_TASK_TRANSITIONS map applies. Agents act through MCP tools,
 * which wrap the same service with actor 'agent' — same rules, same log.
 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get()
  @Permissions('task:list')
  async list(
    @ZodRequest(ListTasksRequestSchema) dto: ListTasksRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListTasksResponse> {
    return this.taskService.list(activeUser, dto);
  }

  @Post()
  @Permissions('task:create')
  async create(
    @ZodRequest(CreateTaskRequestSchema) dto: CreateTaskRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateTaskResponse> {
    return this.taskService.create(activeUser, dto);
  }

  // Bulk draft → ready for a scope (whole project, an Area/group, or a set of
  // task ids), resolving transitive draft prerequisites server-side. Human-only
  // by design: no MCP tool wraps it — `ready` is the human dispatch gate, and
  // an agent must never bulk-promote its own queue. Static path, declared
  // before ':id' so Nest matches it first.
  @Post('mark-ready')
  @Permissions('task:transition')
  async markReady(
    @ZodRequest(MarkReadyRequestSchema) dto: MarkReadyRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<MarkReadyResponse> {
    return this.taskService.markReady(activeUser, dto);
  }

  // Static route before ':id' — Nest matches top-down. Distinct area labels
  // for one project, powering the edit form's autocomplete and the board's
  // group-by-area view.
  @Get('areas')
  @Permissions('task:read')
  async listAreas(
    @ZodRequest(ListTaskAreasRequestSchema) dto: ListTaskAreasRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListTaskAreasResponse> {
    return this.taskService.listAreas(activeUser, dto.projectId);
  }

  @Get(':id')
  @Permissions('task:read')
  async getById(
    @ZodRequest(GetTaskByIdRequestSchema) dto: GetTaskByIdRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetTaskByIdResponse> {
    return this.taskService.getById(activeUser, dto.id);
  }

  @Patch(':id')
  @Permissions('task:update')
  async update(
    @ZodRequest(UpdateTaskRequestSchema) dto: UpdateTaskRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateTaskResponse> {
    return this.taskService.update(activeUser, dto);
  }

  @Delete(':id')
  @Permissions('task:delete')
  async delete(
    @ZodRequest(DeleteTaskRequestSchema) dto: DeleteTaskRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeleteTaskResponse> {
    await this.taskService.delete(activeUser, dto.id);
    return {};
  }

  @Post(':id/transition')
  @Permissions('task:transition')
  async transition(
    @ZodRequest(TransitionTaskRequestSchema) dto: TransitionTaskRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<TransitionTaskResponse> {
    return this.taskService.transition(activeUser, 'user', dto);
  }

  // Human-only by design: no MCP tool wraps merge — an agent must never land
  // its own work on main.
  @Post(':id/merge')
  @Permissions('task:merge')
  async merge(
    @ZodRequest(MergeTaskRequestSchema) dto: MergeTaskRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<MergeTaskResponse> {
    return this.taskService.merge(activeUser, dto);
  }

  @Get(':id/pr')
  @Permissions('task:read')
  async getPr(
    @ZodRequest(GetTaskPrRequestSchema) dto: GetTaskPrRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetTaskPrResponse> {
    return this.taskService.getPr(activeUser, dto);
  }

  @Patch(':id/criteria')
  @Permissions('task:update')
  async checkCriterion(
    @ZodRequest(CheckCriterionRequestSchema) dto: CheckCriterionRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CheckCriterionResponse> {
    return this.taskService.checkCriterion(activeUser, dto);
  }

  // Clearing an assumption flag is the human's review-time veto — no MCP tool
  // wraps it; the agent sets, the human clears. DELETE the flag on the task.
  @Delete(':id/assumption')
  @Permissions('task:update')
  async clearAssumption(
    @ZodRequest(ClearAssumptionRequestSchema) dto: ClearAssumptionRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ClearAssumptionResponse> {
    return this.taskService.clearAssumption(activeUser, dto.id);
  }

  @Post(':id/comments')
  @Permissions('task:comment')
  async addComment(
    @ZodRequest(AddTaskCommentRequestSchema) dto: AddTaskCommentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<AddTaskCommentResponse> {
    return this.taskService.addComment(activeUser, 'user', dto);
  }

  @Post(':id/dependencies')
  @Permissions('task:update')
  async addDependency(
    @ZodRequest(AddTaskDependencyRequestSchema) dto: AddTaskDependencyRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<AddTaskDependencyResponse> {
    await this.taskService.addDependency(activeUser, dto);
    return {};
  }

  @Delete(':id/dependencies/:dependsOnTaskId')
  @Permissions('task:update')
  async removeDependency(
    @ZodRequest(RemoveTaskDependencyRequestSchema) dto: RemoveTaskDependencyRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<RemoveTaskDependencyResponse> {
    await this.taskService.removeDependency(activeUser, dto);
    return {};
  }
}
