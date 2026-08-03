import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import type { ListServersResponse } from '@pkg/contracts';
import { useAuth } from '@/shared/auth/auth-context';
import { useCachedRequest } from '@/shared/hooks/use-cached-request';
import { useActionRequest } from '@/shared/hooks/use-action-request';
import { useCan } from '@/shared/hooks/use-permissions';
import { serversApi } from './api';

/** Org-scoped like every cache key — an org switch must never leak rows. */
const listKey = (orgId: string | undefined) => (orgId ? `servers:${orgId}` : null);

export function useInvalidateServers() {
  const { mutate } = useSWRConfig();
  const { user } = useAuth();
  const key = listKey(user?.orgId);
  return useCallback(() => mutate(key), [mutate, key]);
}

export function useServers() {
  const { user } = useAuth();
  const canList = useCan('settings:read');
  return {
    canList,
    ...useCachedRequest<ListServersResponse>({
      key: canList ? listKey(user?.orgId) : null,
      fetcher: () => serversApi.list({ skip: 0, limit: 100 }),
      // Checks land asynchronously in the worker — keep chips honest.
      config: { refreshInterval: 10_000 },
    }),
  };
}

function useServersAction<TIn, TOut>(action: (dto: TIn) => Promise<TOut>) {
  const invalidate = useInvalidateServers();
  const req = useActionRequest(action);
  const execute = async (dto: TIn) => {
    const res = await req.execute(dto);
    if (!res.e) await invalidate();
    return res;
  };
  return { ...req, execute };
}

export const useCreateServer = () => useServersAction(serversApi.create);
export const useUpdateServer = () => useServersAction(serversApi.update);
export const useRemoveServer = () => useServersAction(serversApi.remove);
export const useTestServer = () => useServersAction(serversApi.test);
