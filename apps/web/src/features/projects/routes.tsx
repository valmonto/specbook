import type { RouteObject } from 'react-router';
import { Navigate, useParams } from 'react-router';

/** The /v2 prefix is retired; old bookmarks land on the canonical URL. */
function V2Redirect() {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/projects/${projectId}`} replace />;
}

/**
 * Route subtree owned by the projects feature. The app router aggregates
 * these; adding a projects route never touches the central router file.
 */
export const projectsRoutes: RouteObject[] = [
  {
    path: 'projects',
    lazy: () => import('./projects.page').then((m) => ({ Component: m.default })),
  },
  {
    path: 'projects/:projectId',
    lazy: () => import('./project-detail.page').then((m) => ({ Component: m.default })),
  },
  { path: 'v2/projects/:projectId', Component: V2Redirect },
];
