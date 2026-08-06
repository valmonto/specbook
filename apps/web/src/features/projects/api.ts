import type {
  AgentActionRequest,
  AgentActionResponse,
  CreateManagedAgentRequest,
  CreateManagedAgentResponse,
  ListAgentsResponse,
  AddTaskCommentRequest,
  ArchiveProjectRequest,
  ArchiveProjectResponse,
  CompleteProvisionRequest,
  CompleteProvisionResponse,
  ConfirmAttachmentRequest,
  ConfirmAttachmentResponse,
  CreateAttachmentUploadRequest,
  CreateAttachmentUploadResponse,
  DeleteAttachmentRequest,
  DeleteAttachmentResponse,
  ListAttachmentsRequest,
  ListAttachmentsResponse,
  AddTaskCommentResponse,
  AddTaskDependencyRequest,
  AddTaskDependencyResponse,
  CheckCriterionRequest,
  CheckCriterionResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DeleteProjectRequest,
  DeleteProjectResponse,
  DeleteTaskRequest,
  DeleteTaskResponse,
  GetProjectByIdRequest,
  GetProjectByIdResponse,
  GetTaskByIdRequest,
  GetTaskByIdResponse,
  GetTaskPrRequest,
  GetTaskPrResponse,
  MergeTaskRequest,
  MergeTaskResponse,
  ListProjectsRequest,
  ListProjectsResponse,
  ListTasksRequest,
  ListTasksResponse,
  RemoveTaskDependencyRequest,
  RemoveTaskDependencyResponse,
  TransitionTaskRequest,
  TransitionTaskResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
} from '@pkg/contracts';
import { http, type HttpClient } from '@/shared/api/http';

/**
 * Factory kept exported so the global `api` aggregator can compose it.
 * Prefer the feature-local hooks over reaching for this directly.
 */
export const projectsResource = (client: HttpClient) => ({
  // Projects
  createProject: (dto: CreateProjectRequest): Promise<CreateProjectResponse> =>
    client.post('/api/projects', dto),
  listProjects: (dto: ListProjectsRequest): Promise<ListProjectsResponse> =>
    client.get('/api/projects', { params: dto }),
  getProject: (dto: GetProjectByIdRequest): Promise<GetProjectByIdResponse> =>
    client.get(`/api/projects/${dto.id}`),
  updateProject: (dto: UpdateProjectRequest): Promise<UpdateProjectResponse> =>
    client.patch(`/api/projects/${dto.id}`, dto),
  removeProject: (dto: DeleteProjectRequest): Promise<DeleteProjectResponse> =>
    client.delete(`/api/projects/${dto.id}`),
  completeProvision: (dto: CompleteProvisionRequest): Promise<CompleteProvisionResponse> =>
    client.post(`/api/projects/${dto.id}/provision/complete`, dto),
  archiveProject: (dto: ArchiveProjectRequest): Promise<ArchiveProjectResponse> =>
    client.post(`/api/projects/${dto.id}/archive`, {}),
  unarchiveProject: (dto: ArchiveProjectRequest): Promise<ArchiveProjectResponse> =>
    client.post(`/api/projects/${dto.id}/unarchive`, {}),

  // Agents (the fleet strip + managed lifecycle)
  listAgents: (): Promise<ListAgentsResponse> => client.get('/api/agents'),
  createManagedAgent: (dto: CreateManagedAgentRequest): Promise<CreateManagedAgentResponse> =>
    client.post('/api/agents/managed', dto),
  startAgent: (dto: AgentActionRequest): Promise<AgentActionResponse> =>
    client.post(`/api/agents/${dto.id}/start`, {}),
  stopAgent: (dto: AgentActionRequest): Promise<AgentActionResponse> =>
    client.post(`/api/agents/${dto.id}/stop`, {}),

  // Tasks
  createTask: (dto: CreateTaskRequest): Promise<CreateTaskResponse> =>
    client.post('/api/tasks', dto),
  listTasks: (dto: ListTasksRequest): Promise<ListTasksResponse> =>
    client.get('/api/tasks', { params: dto }),
  getTask: (dto: GetTaskByIdRequest): Promise<GetTaskByIdResponse> =>
    client.get(`/api/tasks/${dto.id}`),
  updateTask: (dto: UpdateTaskRequest): Promise<UpdateTaskResponse> =>
    client.patch(`/api/tasks/${dto.id}`, dto),
  removeTask: (dto: DeleteTaskRequest): Promise<DeleteTaskResponse> =>
    client.delete(`/api/tasks/${dto.id}`),
  transitionTask: (dto: TransitionTaskRequest): Promise<TransitionTaskResponse> =>
    client.post(`/api/tasks/${dto.id}/transition`, dto),
  mergeTask: (dto: MergeTaskRequest): Promise<MergeTaskResponse> =>
    client.post(`/api/tasks/${dto.id}/merge`, dto),
  getTaskPr: (dto: GetTaskPrRequest): Promise<GetTaskPrResponse> =>
    client.get(`/api/tasks/${dto.id}/pr`),
  checkCriterion: (dto: CheckCriterionRequest): Promise<CheckCriterionResponse> =>
    client.patch(`/api/tasks/${dto.id}/criteria`, dto),
  addComment: (dto: AddTaskCommentRequest): Promise<AddTaskCommentResponse> =>
    client.post(`/api/tasks/${dto.id}/comments`, dto),
  addDependency: (dto: AddTaskDependencyRequest): Promise<AddTaskDependencyResponse> =>
    client.post(`/api/tasks/${dto.id}/dependencies`, dto),
  removeDependency: (dto: RemoveTaskDependencyRequest): Promise<RemoveTaskDependencyResponse> =>
    client.delete(`/api/tasks/${dto.id}/dependencies/${dto.dependsOnTaskId}`),

  // Attachments (three-step protocol: declare -> PUT to storage -> confirm)
  createAttachmentUpload: (
    dto: CreateAttachmentUploadRequest,
  ): Promise<CreateAttachmentUploadResponse> => client.post('/api/attachments/uploads', dto),
  confirmAttachment: (dto: ConfirmAttachmentRequest): Promise<ConfirmAttachmentResponse> =>
    client.post(`/api/attachments/${dto.id}/confirm`, dto),
  listAttachments: (dto: ListAttachmentsRequest): Promise<ListAttachmentsResponse> =>
    client.get('/api/attachments', { params: dto }),
  removeAttachment: (dto: DeleteAttachmentRequest): Promise<DeleteAttachmentResponse> =>
    client.delete(`/api/attachments/${dto.id}`),
});

/** Bound instance the feature uses internally. */
export const projectsApi = projectsResource(http);
