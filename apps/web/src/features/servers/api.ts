import type {
  CreateServerRequest,
  CreateServerResponse,
  DeleteServerRequest,
  DeleteServerResponse,
  ListServersRequest,
  ListServersResponse,
  TestServerRequest,
  TestServerResponse,
  UpdateServerRequest,
  UpdateServerResponse,
} from '@pkg/contracts';
import { http } from '@/shared/api/http';

export const serversApi = {
  list: (dto: ListServersRequest): Promise<ListServersResponse> =>
    http.get('/api/servers', { params: dto }),
  create: (dto: CreateServerRequest): Promise<CreateServerResponse> =>
    http.post('/api/servers', dto),
  update: (dto: UpdateServerRequest): Promise<UpdateServerResponse> =>
    http.patch(`/api/servers/${dto.id}`, dto),
  remove: (dto: DeleteServerRequest): Promise<DeleteServerResponse> =>
    http.delete(`/api/servers/${dto.id}`),
  test: (dto: TestServerRequest): Promise<TestServerResponse> =>
    http.post(`/api/servers/${dto.id}/test`, {}),
};
