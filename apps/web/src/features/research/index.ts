/**
 * Public surface of the research feature. Other layers import from here
 * (`@/features/research`) and never reach into internal files directly — the
 * ESLint boundaries rule enforces this.
 */
export { researchRoutes } from './routes';
export { researchResource } from './api';
export {
  useResearch,
  useRecentResearch,
  useResearchSearch,
  useCreateResearch,
  useAppendMessage,
  useAcceptResearch,
} from './hooks/use-research';
