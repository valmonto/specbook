import type { RouteObject } from 'react-router';

/**
 * Route subtree owned by the research feature. Research is a single sidebar
 * destination: `/research` is the launcher home, `/research/:researchId` the
 * conversation + living document. The app router aggregates these.
 */
export const researchRoutes: RouteObject[] = [
  {
    path: 'research',
    lazy: () => import('./research.page').then((m) => ({ Component: m.default })),
  },
  {
    path: 'research/:researchId',
    lazy: () => import('./research-detail.page').then((m) => ({ Component: m.default })),
  },
];
