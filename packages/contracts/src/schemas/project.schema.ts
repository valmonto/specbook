import { z } from 'zod';
import { PROJECT_MODES } from '../constants';
import { PaginatedRequestSchema, PaginatedResponseSchema } from './pagination.schema';

export const ProjectModeSchema = z.enum(PROJECT_MODES);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

// --- Project Entity ---
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  context: z.string().nullable(),
  repoUrl: z.string().nullable(),
  /** Set when the repo was picked from the org's GitHub installation — later
   *  credential minting restricts tokens to exactly this repository. */
  githubRepoId: z.number().int().nullable(),
  githubRepoFullName: z.string().nullable(),
  defaultBranch: z.string(),
  workdir: z.string().nullable(),
  /** The automation trust dial — see PROJECT_MODES. */
  mode: ProjectModeSchema,
  /** Per-project claim cap for the agent queue; null = no project cap. */
  maxParallel: z.number().int().nullable(),
  /** Set while the circuit breaker holds auto progression (red default branch). */
  autoPausedAt: z.string().nullable(),
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
    /** Pick from the org's installation: the server verifies the repo is in
     *  the grant and derives repoUrl + full name itself — the client cannot
     *  bind a project to a repo the installation does not cover. */
    githubRepoId: z.number().int().positive().optional(),
    /** Provision a NEW repository with this name (GitHub repo-name charset)
     *  in the connected account — mutually exclusive with githubRepoId. */
    newRepoName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/, 'invalid repository name')
      .optional(),
    /** Generate the new repo from the deploy's configured template. */
    newRepoFromTemplate: z.boolean().optional(),
    defaultBranch: z.string().min(1).max(255).optional(),
    workdir: z.string().max(500).optional(),
    mode: ProjectModeSchema.optional(),
    maxParallel: z.number().int().min(1).max(10).nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.githubRepoId && v.newRepoName), {
    message: 'pick an existing repository or create a new one, not both',
    path: ['newRepoName'],
  });

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
    /** Number = rebind (verified against the installation grant, repoUrl and
     *  full name derived server-side); null = clear the binding. */
    githubRepoId: z.number().int().positive().nullable().optional(),
    defaultBranch: z.string().min(1).max(255).optional(),
    workdir: z.string().max(500).nullable().optional(),
    mode: ProjectModeSchema.optional(),
    maxParallel: z.number().int().min(1).max(10).nullable().optional(),
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
