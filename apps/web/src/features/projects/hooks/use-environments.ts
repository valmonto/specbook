import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import type { ListDataAccessAuditResponse, ListEnvironmentsResponse } from '@pkg/contracts';
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
    // Provisioning lands asynchronously in the worker — keep chips honest.
    config: { refreshInterval: 10_000 },
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
export const useProvisionEnvironment = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.provision);
export const useDeployEnvironment = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.deploy);
export const useRemoveEnvironment = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.remove);
export const useSetEnvVar = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.setVar);
export const useDeleteEnvVar = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.deleteVar);
export const useBulkSetEnvVars = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.bulkSetVars);
// Reveal is an on-demand read (never auto-fetched and it mutates no cache), so
// it stays a plain action. The projectId is unused here — it rides the dto.
export const useRevealEnvVars = (_projectId: string) =>
  useActionRequest(environmentsApi.revealVars);
export const useGrantMcpAccess = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.grantMcpAccess);
export const useRevokeMcpAccess = (projectId: string) =>
  useEnvironmentsAction(projectId, environmentsApi.revokeMcpAccess);

/** The audit trail of one environment; null id = not requested (collapsed). */
export function useAccessAudit(projectId: string, environmentId: string | null) {
  return useCachedRequest<ListDataAccessAuditResponse>({
    key: environmentId ? `environments:${projectId}:${environmentId}:audit` : null,
    fetcher: () => environmentsApi.listAccessAudit({ projectId, id: environmentId!, limit: 50 }),
    config: { refreshInterval: 10_000 },
  });
}
