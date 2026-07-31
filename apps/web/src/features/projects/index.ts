/**
 * Public surface of the projects feature. Other layers import from here
 * (`@/features/projects`) and never reach into internal files directly —
 * the ESLint boundaries rule enforces this.
 */
export { projectsRoutes } from './routes';
export { default as YourMovePage } from './your-move.page';
export { projectsResource } from './api';
export {
  useProjects,
  useProject,
  useProjectTasks,
  useTask,
  useCreateProject,
  useCreateTask,
  useTransitionTask,
} from './hooks/use-projects';
