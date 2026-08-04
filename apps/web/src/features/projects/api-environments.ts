import type {
  CreateEnvironmentRequest,
  CreateEnvironmentResponse,
  DeleteEnvironmentRequest,
  DeleteEnvironmentResponse,
  DeleteEnvVarRequest,
  DeleteEnvVarResponse,
  DeployEnvironmentRequest,
  DeployEnvironmentResponse,
  ListEnvironmentsRequest,
  ListEnvironmentsResponse,
  ProvisionEnvironmentRequest,
  ProvisionEnvironmentResponse,
  SetEnvVarRequest,
  SetEnvVarResponse,
  UpdateEnvironmentRequest,
  UpdateEnvironmentResponse,
} from '@pkg/contracts';
import { http } from '@/shared/api/http';

export const environmentsApi = {
  list: (dto: ListEnvironmentsRequest): Promise<ListEnvironmentsResponse> =>
    http.get(`/api/projects/${dto.projectId}/environments`),
  create: (dto: CreateEnvironmentRequest): Promise<CreateEnvironmentResponse> =>
    http.post(`/api/projects/${dto.projectId}/environments`, dto),
  update: (dto: UpdateEnvironmentRequest): Promise<UpdateEnvironmentResponse> =>
    http.patch(`/api/projects/${dto.projectId}/environments/${dto.id}`, dto),
  remove: (dto: DeleteEnvironmentRequest): Promise<DeleteEnvironmentResponse> =>
    http.delete(`/api/projects/${dto.projectId}/environments/${dto.id}`),
  provision: (dto: ProvisionEnvironmentRequest): Promise<ProvisionEnvironmentResponse> =>
    http.post(`/api/projects/${dto.projectId}/environments/${dto.id}/provision`, {}),
  deploy: (dto: DeployEnvironmentRequest): Promise<DeployEnvironmentResponse> =>
    http.post(`/api/projects/${dto.projectId}/environments/${dto.id}/deploy`, {}),
  // The value rides the body; it is write-only — no endpoint returns it back.
  setVar: (dto: SetEnvVarRequest): Promise<SetEnvVarResponse> =>
    http.put(`/api/projects/${dto.projectId}/environments/${dto.id}/env/${dto.name}`, {
      value: dto.value,
    }),
  deleteVar: (dto: DeleteEnvVarRequest): Promise<DeleteEnvVarResponse> =>
    http.delete(`/api/projects/${dto.projectId}/environments/${dto.id}/env/${dto.name}`),
};
