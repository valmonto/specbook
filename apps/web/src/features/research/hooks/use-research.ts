import { useCallback } from 'react';
import { useSWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';
import type {
  AcceptResearchRequest,
  AppendResearchMessageRequest,
  CreateResearchRequest,
  CutTicketsRequest,
  DeleteResearchRequest,
  GetResearchResponse,
  ListProjectsResponse,
  ListResearchResponse,
  ReopenResearchRequest,
  Research,
  UpdateResearchRequest,
} from '@pkg/contracts';
import { useAuth } from '@/shared/auth/auth-context';
import { useCachedRequest } from '@/shared/hooks/use-cached-request';
import { useActionRequest } from '@/shared/hooks/use-action-request';
import { useCan } from '@/shared/hooks/use-permissions';
import { researchApi } from '../api';

/**
 * Cache keys are namespaced by org so switching tenants can never surface
 * another org's cached rows (same discipline as the projects feature). The
 * whole research domain shares one prefix: appending a message can change the
 * document's status/version and the recent list's ordering, so it all
 * revalidates together.
 */
const prefix = (orgId: string | undefined) => (orgId ? `org:${orgId}/research` : null);
const researchKey = (orgId: string | undefined, id: string | null) =>
  prefix(orgId) && id ? `${prefix(orgId)}/${id}` : null;
const recentKey = (orgId: string | undefined, limit: number) =>
  prefix(orgId) && `${prefix(orgId)}?recent=${limit}`;

const RECENT_LIMIT = 6;
const SEARCH_PAGE = 20;

export function useInvalidateResearch() {
  const { mutate } = useSWRConfig();
  const { user } = useAuth();
  const p = prefix(user?.orgId);

  return useCallback(
    () =>
      mutate((key) => {
        if (p === null) return false;
        if (typeof key === 'string') return key.startsWith(p);
        // Infinite-scroll search keys are objects; match on their scope prefix.
        return (
          typeof key === 'object' &&
          key !== null &&
          'scope' in key &&
          typeof (key as { scope: unknown }).scope === 'string' &&
          (key as { scope: string }).scope.startsWith(p)
        );
      }),
    [mutate, p],
  );
}

/** One research: the living document plus its first page of messages. */
export function useResearch(id: string | null) {
  const { user } = useAuth();
  const canRead = useCan('research:read');

  return useCachedRequest<GetResearchResponse>({
    key: canRead ? researchKey(user?.orgId, id) : null,
    fetcher: () => researchApi.getResearch({ id: id! }),
  });
}

/** The launcher's "Recent" strip — newest-updated first. */
export function useRecentResearch(limit = RECENT_LIMIT) {
  const { user } = useAuth();
  const canRead = useCan('research:read');

  return useCachedRequest<ListResearchResponse>({
    key: canRead ? recentKey(user?.orgId, limit) : null,
    fetcher: () => researchApi.listResearch({ limit }),
  });
}

/**
 * The org's live projects — the associated-project chip and the cut-tickets
 * target picker read from this. Gated by `project:list`; without it the picker
 * simply has no options to offer.
 */
export function useProjectOptions() {
  const { user } = useAuth();
  const canList = useCan('project:list');

  return useCachedRequest<ListProjectsResponse>({
    key: canList && prefix(user?.orgId) ? `${prefix(user?.orgId)}?projects` : null,
    fetcher: () => researchApi.listProjects({ skip: 0, limit: 100 }),
  });
}

type SearchKey = { scope: string; q: string; cursor?: string };

/**
 * "Search all research" — infinite scroll over the keyset feed. Each page's
 * `meta.nextCursor` seeds the next request; a null cursor is the end.
 */
export function useResearchSearch(q: string) {
  const { user } = useAuth();
  const canRead = useCan('research:read');
  const p = prefix(user?.orgId);
  const query = q.trim();

  const getKey = (index: number, previous: ListResearchResponse | null): SearchKey | null => {
    if (!canRead || p === null) return null;
    if (previous && previous.meta.nextCursor === null) return null; // exhausted
    const cursor = index === 0 ? undefined : (previous?.meta.nextCursor ?? undefined);
    return { scope: `${p}/search`, q: query, cursor };
  };

  const { data, error, size, setSize, isLoading, isValidating, mutate } =
    useSWRInfinite<ListResearchResponse>(getKey, (key: SearchKey) =>
      researchApi.listResearch({
        limit: SEARCH_PAGE,
        ...(key.q ? { q: key.q } : {}),
        ...(key.cursor ? { cursor: key.cursor } : {}),
      }),
    );

  const pages = data ?? [];
  const items: Research[] = pages.flatMap((page) => page.data);
  const last = pages.at(-1);
  const hasMore = last ? last.meta.nextCursor !== null : true;
  const isLoadingInitial = isLoading && pages.length === 0;
  const isLoadingMore =
    isValidating && pages.length > 0 && typeof data?.[size - 1] === 'undefined';

  return {
    items,
    error: error as Error | null,
    hasMore,
    isLoadingInitial,
    isLoadingMore,
    loadMore: () => void setSize((s) => s + 1),
    mutate,
  };
}

/** Wraps an API action so success revalidates the whole research domain. */
function useResearchAction<TIn, TOut>(action: (dto: TIn) => Promise<TOut>) {
  const invalidate = useInvalidateResearch();
  const req = useActionRequest(action);
  const execute = async (dto: TIn) => {
    const res = await req.execute(dto);
    if (!res.e) await invalidate();
    return res;
  };
  return { ...req, execute };
}

export const useCreateResearch = () =>
  useResearchAction((dto: CreateResearchRequest) => researchApi.createResearch(dto));
export const useUpdateResearch = () =>
  useResearchAction((dto: UpdateResearchRequest) => researchApi.updateResearch(dto));
export const useAppendMessage = () =>
  useResearchAction((dto: AppendResearchMessageRequest) => researchApi.appendMessage(dto));
export const useAcceptResearch = () =>
  useResearchAction((dto: AcceptResearchRequest) => researchApi.acceptResearch(dto));
export const useReopenResearch = () =>
  useResearchAction((dto: ReopenResearchRequest) => researchApi.reopenResearch(dto));
export const useCutTickets = () =>
  useResearchAction((dto: CutTicketsRequest) => researchApi.cutTickets(dto));
export const useDeleteResearch = () =>
  useResearchAction((dto: DeleteResearchRequest) => researchApi.removeResearch(dto));
