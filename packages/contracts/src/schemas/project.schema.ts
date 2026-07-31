import { z } from 'zod';
import { PaginatedRequestSchema, PaginatedResponseSchema } from './pagination.schema';

// --- Project Entity ---
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  context: z.string().nullable(),
  repoUrl: z.string().nullable(),
  defaultBranch: z.string(),
  workdir: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Tasks per status — present on list responses; a strip, not analytics. */
  statusCounts: z.record(z.string(), z.number().int()).optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

// --- Create Project ---
export const CreateProjectRequestSchema = z
  .object({
    name: z.string().min(1).max(255),
    context: z.string().max(100_000).optional(),
    repoUrl: z.string().max(500).optional(),
    defaultBranch: z.string().min(1).max(255).optional(),
    workdir: z.string().max(500).optional(),
  })
  .strict();

export const CreateProjectResponseSchema = ProjectSchema;

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

// --- Update Project ---
export const UpdateProjectRequestSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255).optional(),
    context: z.string().max(100_000).nullable().optional(),
    repoUrl: z.string().max(500).nullable().optional(),
    defaultBranch: z.string().min(1).max(255).optional(),
    workdir: z.string().max(500).nullable().optional(),
  })
  .strict();

export const UpdateProjectResponseSchema = ProjectSchema;

export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponseSchema>;

// --- List Projects ---
export const ListProjectsRequestSchema = PaginatedRequestSchema.strict();
export const ListProjectsResponseSchema = PaginatedResponseSchema(ProjectSchema);

export type ListProjectsRequest = z.infer<typeof ListProjectsRequestSchema>;
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

// --- Get Project by ID ---
export const GetProjectByIdRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const GetProjectByIdResponseSchema = ProjectSchema;

export type GetProjectByIdRequest = z.infer<typeof GetProjectByIdRequestSchema>;
export type GetProjectByIdResponse = z.infer<typeof GetProjectByIdResponseSchema>;

// --- Delete Project ---
export const DeleteProjectRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const DeleteProjectResponseSchema = z.object({});

export type DeleteProjectRequest = z.infer<typeof DeleteProjectRequestSchema>;
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;
