import { createContext, useContext } from 'react';

/**
 * True inside an ARCHIVED project's view: every edit affordance renders as
 * plain reading surface. The API enforces the same boundary server-side —
 * this context only keeps the UI honest about it.
 */
export const ProjectReadOnlyContext = createContext(false);
export const useProjectReadOnly = () => useContext(ProjectReadOnlyContext);
