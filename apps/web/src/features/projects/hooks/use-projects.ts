import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import type {
  CreateProjectRequest,
  TaskStatus,
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

/** Cross-project task list for one status — the dashboard's data source. */
export function useTasksByStatus(status: TaskStatus, limit = 100) {
  const { user } = useAuth();
  const canList = useCan('task:list');
  const params: ListTasksRequest = { status, skip: 0, limit, available: false };

  return useCachedRequest<ListTasksResponse>({
    key: canList ? taskListKey(user?.orgId, params) : null,
    fetcher: () => projectsApi.listTasks(params),
  });
}

/** Just the total for a status — queue-health counters. */
export function useTaskCount(status: TaskStatus) {
  const { user } = useAuth();
  const canList = useCan('task:list');
  const params: ListTasksRequest = { status, skip: 0, limit: 1, available: false };

  const { data, ...rest } = useCachedRequest<ListTasksResponse>({
    key: canList ? taskListKey(user?.orgId, params) : null,
    fetcher: () => projectsApi.listTasks(params),
  });
  return { count: data?.meta.total ?? 0, ...rest };
}

/**
 * Latest question per blocked task. Blocked tasks are few by nature, so one
 * detail fetch each is fine; keyed by the id set so the cache tracks changes.
 */
export function useBlockedQuestions(ids: string[]) {
  const { user } = useAuth();
  const canRead = useCan('task:read');
  const key =
    canRead && ids.length > 0 && prefix(user?.orgId)
      ? `${prefix(user?.orgId)}/blocked-questions?${ids.join(',')}`
      : null;

  return useCachedRequest<Record<string, string>>({
    key,
    fetcher: async () => {
      const details = await Promise.all(ids.map((id) => projectsApi.getTask({ id })));
      const questions: Record<string, string> = {};
      for (const detail of details) {
        const question = [...detail.comments].reverse().find((c) => c.kind === 'question');
        if (question) questions[detail.id] = question.body;
      }
      return questions;
    },
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
