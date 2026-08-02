import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  AddTaskCommentRequestSchema,
  AddTaskDependencyRequestSchema,
  CheckCriterionRequestSchema,
  CreateTaskRequestSchema,
  DeleteTaskRequestSchema,
  GetTaskByIdRequestSchema,
  GetTaskPrRequestSchema,
  ListTasksRequestSchema,
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
  type CreateTaskRequest,
  type CreateTaskResponse,
  type DeleteTaskRequest,
  type DeleteTaskResponse,
  type GetTaskByIdRequest,
  type GetTaskByIdResponse,
  type GetTaskPrRequest,
  type GetTaskPrResponse,
  type ListTasksRequest,
  type ListTasksResponse,
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
