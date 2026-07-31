import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import type {
  CreateProjectRequest,
  CreateTaskRequest,
  DeleteProjectRequest,
  DeleteTaskRequest,
  GetProjectByIdResponse,
  GetTaskByIdResponse,
  ListProjectsResponse,
  ListTasksRequest,
  ListTasksResponse,
  UpdateProjectRequest,
} from '@pkg/contracts';
import { useAuth } from '@/shared/auth/auth-context';
import { useCachedRequest } from '@/shared/hooks/use-cached-request';
import { useActionRequest } from '@/shared/hooks/use-action-request';
import { useCan } from '@/shared/hooks/use-permissions';
import { projectsApi } from '../api';

/**
 * Cache keys are namespaced by org so switching tenants can never surface
 * another org's cached rows (same discipline as the users feature). Projects
 * and tasks share one prefix: a task mutation can change what a project view
 * shows (counts, board columns), so the whole domain revalidates together.
 */
const prefix = (orgId: string | undefined) => (orgId ? `org:${orgId}/projects` : null);
const projectListKey = (orgId: string | undefined) => prefix(orgId) && `${prefix(orgId)}?list`;
const projectKey = (orgId: string | undefined, id: string | null) =>
  prefix(orgId) && id ? `${prefix(orgId)}/${id}` : null;
const taskListKey = (orgId: string | undefined, params: ListTasksRequest) =>
  prefix(orgId) && `${prefix(orgId)}/tasks?${JSON.stringify(params)}`;
const taskKey = (orgId: string | undefined, id: string | null) =>
  prefix(orgId) && id ? `${prefix(orgId)}/tasks/${id}` : null;

export function useInvalidateProjects() {
  const { mutate } = useSWRConfig();
  const { user } = useAuth();
  const p = prefix(user?.orgId);

  return useCallback(
    () => mutate((key) => typeof key === 'string' && p !== null && key.startsWith(p)),
    [mutate, p],
  );
}

export function useProjects() {
  const { user } = useAuth();
  const canList = useCan('project:list');

  return {
    canList,
    ...useCachedRequest<ListProjectsResponse>({
      key: canList ? projectListKey(user?.orgId) : null,
      fetcher: () => projectsApi.listProjects({ skip: 0, limit: 100 }),
    }),
  };
}

export function useProject(id: string | null) {
  const { user } = useAuth();
  const canRead = useCan('project:read');

  return useCachedRequest<GetProjectByIdResponse>({
    key: canRead ? projectKey(user?.orgId, id) : null,
    fetcher: () => projectsApi.getProject({ id: id! }),
  });
}

export function useProjectTasks(projectId: string | null) {
  const { user } = useAuth();
  const canList = useCan('task:list');
  const params: ListTasksRequest = {
    projectId: projectId ?? undefined,
    skip: 0,
    limit: 100,
    available: false,
  };

  return useCachedRequest<ListTasksResponse>({
    key: canList && projectId ? taskListKey(user?.orgId, params) : null,
    fetcher: () => projectsApi.listTasks(params),
  });
}

export function useTask(id: string | null) {
  const { user } = useAuth();
  const canRead = useCan('task:read');

  return useCachedRequest<GetTaskByIdResponse>({
    key: canRead ? taskKey(user?.orgId, id) : null,
    fetcher: () => projectsApi.getTask({ id: id! }),
  });
}

/** Wraps an API action so success revalidates the whole projects domain. */
function useProjectsAction<TIn, TOut>(action: (dto: TIn) => Promise<TOut>) {
  const invalidate = useInvalidateProjects();
  const req = useActionRequest(action);
  const execute = async (dto: TIn) => {
    const res = await req.execute(dto);
    if (!res.e) await invalidate();
    return res;
  };
  return { ...req, execute };
}

export const useCreateProject = () =>
  useProjectsAction((dto: CreateProjectRequest) => projectsApi.createProject(dto));
export const useUpdateProject = () =>
  useProjectsAction((dto: UpdateProjectRequest) => projectsApi.updateProject(dto));
export const useDeleteProject = () =>
  useProjectsAction((dto: DeleteProjectRequest) => projectsApi.removeProject(dto));
export const useCreateTask = () =>
  useProjectsAction((dto: CreateTaskRequest) => projectsApi.createTask(dto));
export const useUpdateTask = () => useProjectsAction(projectsApi.updateTask);
export const useDeleteTask = () =>
  useProjectsAction((dto: DeleteTaskRequest) => projectsApi.removeTask(dto));
export const useTransitionTask = () => useProjectsAction(projectsApi.transitionTask);
export const useCheckCriterion = () => useProjectsAction(projectsApi.checkCriterion);
export const useAddComment = () => useProjectsAction(projectsApi.addComment);
export const useAddDependency = () => useProjectsAction(projectsApi.addDependency);
export const useRemoveDependency = () => useProjectsAction(projectsApi.removeDependency);
