import type {
  AcceptResearchRequest,
  AcceptResearchResponse,
  AppendResearchMessageRequest,
  AppendResearchMessageResponse,
  CreateResearchRequest,
  CreateResearchResponse,
  CutTicketsRequest,
  CutTicketsResponse,
  DeleteResearchRequest,
  DeleteResearchResponse,
  GetResearchRequest,
  GetResearchResponse,
  ListProjectsRequest,
  ListProjectsResponse,
  ListResearchRequest,
  ListResearchResponse,
  ReopenResearchRequest,
  ReopenResearchResponse,
  UpdateResearchRequest,
  UpdateResearchResponse,
} from '@pkg/contracts';
import { http, type HttpClient } from '@/shared/api/http';

/**
 * Factory kept exported so the global `api` aggregator can compose it.
 * Prefer the feature-local hooks over reaching for this directly.
 *
 * The list is keyset-paginated ({ data, meta.nextCursor }) rather than
 * offset-based — the launcher's "search all" scrolls it forever without a page
 * skipping or double-counting when new research lands at the head.
 */
export const researchResource = (client: HttpClient) => ({
  listResearch: (dto: ListResearchRequest): Promise<ListResearchResponse> =>
    client.get('/api/research', { params: dto }),
  createResearch: (dto: CreateResearchRequest): Promise<CreateResearchResponse> =>
    client.post('/api/research', dto),
  getResearch: (dto: GetResearchRequest): Promise<GetResearchResponse> =>
    client.get(`/api/research/${dto.id}`),
  updateResearch: (dto: UpdateResearchRequest): Promise<UpdateResearchResponse> =>
    client.patch(`/api/research/${dto.id}`, dto),
  appendMessage: (dto: AppendResearchMessageRequest): Promise<AppendResearchMessageResponse> =>
    client.post(`/api/research/${dto.id}/messages`, dto),
  acceptResearch: (dto: AcceptResearchRequest): Promise<AcceptResearchResponse> =>
    client.post(`/api/research/${dto.id}/accept`, {}),
  reopenResearch: (dto: ReopenResearchRequest): Promise<ReopenResearchResponse> =>
    client.post(`/api/research/${dto.id}/reopen`, dto),
  cutTickets: (dto: CutTicketsRequest): Promise<CutTicketsResponse> =>
    client.post(`/api/research/${dto.id}/cut-tickets`, dto),
  removeResearch: (dto: DeleteResearchRequest): Promise<DeleteResearchResponse> =>
    client.delete(`/api/research/${dto.id}`),
  // The associated-project chip and the cut-tickets target both need the org's
  // project list. Fetched here (not through the projects feature) so the
  // feature-boundary rule stays intact — the projects feature owns projects, we
  // only read their names to steer research.
  listProjects: (dto: ListProjectsRequest): Promise<ListProjectsResponse> =>
    client.get('/api/projects', { params: dto }),
});

/** Bound instance the feature uses internally. */
export const researchApi = researchResource(http);
