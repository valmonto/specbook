import type { RouteObject } from 'react-router';

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
];
