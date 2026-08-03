import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import type { ListEnvironmentsResponse } from '@pkg/contracts';
import { useCachedRequest } from '@/shared/hooks/use-cached-request';
import { useActionRequest } from '@/shared/hooks/use-action-request';
import { environmentsApi } from '../api-environments';

// Project-scoped: the project id is globally unique, and org switches reset
// every cache anyway.
const listKey = (projectId: string | null) => (projectId ? `environments:${projectId}` : null);

export function useEnvironments(projectId: string | null) {
  return useCachedRequest<ListEnvironmentsResponse>({
    key: listKey(projectId),
    fetcher: () => environmentsApi.list({ projectId: projectId! }),
  });
}

function useInvalidateEnvironments(projectId: string) {
  const { mutate } = useSWRConfig();
  return useCallback(() => mutate(listKey(projectId)), [mutate, projectId]);
}

function useEnvironmentsAction<TIn, TOut>(projectId: string, action: (dto: TIn) => Promise<TOut>) {
  const invalidate = useInvalidateEnvironments(projectId);
  const req = useActionRequest(action);
  const execute = async (dto: TIn) => {
    const res = await req.execute(dto);
    if (!res.e) await invalidate();
    return res;
  };
  return { ...req, execute };
}

export const useCreateEnvironment = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.create);
export const useUpdateEnvironment = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.update);
export const useRemoveEnvironment = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.remove);
export const useSetEnvVar = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.setVar);
export const useDeleteEnvVar = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.deleteVar);
