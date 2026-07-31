import type {
  AddTaskCommentRequest,
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
  checkCriterion: (dto: CheckCriterionRequest): Promise<CheckCriterionResponse> =>
    client.patch(`/api/tasks/${dto.id}/criteria`, dto),
  addComment: (dto: AddTaskCommentRequest): Promise<AddTaskCommentResponse> =>
    client.post(`/api/tasks/${dto.id}/comments`, dto),
  addDependency: (dto: AddTaskDependencyRequest): Promise<AddTaskDependencyResponse> =>
    client.post(`/api/tasks/${dto.id}/dependencies`, dto),
  removeDependency: (dto: RemoveTaskDependencyRequest): Promise<RemoveTaskDependencyResponse> =>
    client.delete(`/api/tasks/${dto.id}/dependencies/${dto.dependsOnTaskId}`),
});

/** Bound instance the feature uses internally. */
export const projectsApi = projectsResource(http);
