import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import type {
  ConnectGithubRequest,
  ConnectGithubResponse,
  DisconnectGithubRequest,
  DisconnectGithubResponse,
  GetGithubStatusRequest,
  GetGithubStatusResponse,
} from '@pkg/contracts';
import { http } from '@/shared/api/http';
import { useCachedRequest } from '@/shared/hooks/use-cached-request';
import { useActionRequest } from '@/shared/hooks/use-action-request';

/**
 * The org ↔ GitHub connection surface. Lives in shared/ (not features/org)
 * because two features consume it: the settings GitHub card and the project
 * form's repo picker — and features may not import each other.
 *
 * All endpoints sit under /:orgId, so the API pins them to the session's
 * active organization.
 */
export const githubApi = {
  status: (dto: GetGithubStatusRequest): Promise<GetGithubStatusResponse> =>
    http.get(`/api/orgs/${dto.orgId}/github`),

  connect: (dto: ConnectGithubRequest): Promise<ConnectGithubResponse> =>
    http.post(`/api/orgs/${dto.orgId}/github`, dto),

  disconnect: (dto: DisconnectGithubRequest): Promise<DisconnectGithubResponse> =>
    http.delete(`/api/orgs/${dto.orgId}/github`),
};

/** Org-scoped on purpose: an org switch resets all caches, re-keying this. */
const githubKey = (orgId: string | undefined) => (orgId ? `github:${orgId}` : null);

function useInvalidateGithub(orgId: string | undefined) {
  const { mutate } = useSWRConfig();
  return useCallback(() => mutate(githubKey(orgId)), [mutate, orgId]);
}

export function useGithubStatus(orgId: string | undefined) {
  return useCachedRequest({
    key: githubKey(orgId),
    fetcher: () => githubApi.status({ orgId: orgId! }),
  });
}

export function useConnectGithub(orgId: string | undefined) {
  const invalidate = useInvalidateGithub(orgId);
  const req = useActionRequest(githubApi.connect);
  const execute = async (dto: ConnectGithubRequest) => {
    const res = await req.execute(dto);
    if (!res.e) await invalidate();
    return res;
  };
  return { ...req, execute };
}

export function useDisconnectGithub(orgId: string | undefined) {
  const invalidate = useInvalidateGithub(orgId);
  const req = useActionRequest(githubApi.disconnect);
  const execute = async (dto: DisconnectGithubRequest) => {
    const res = await req.execute(dto);
    if (!res.e) await invalidate();
    return res;
  };
  return { ...req, execute };
}
