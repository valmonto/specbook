/**
 * Centralized translation keys
 *
 * Usage:
 *   import { k } from '@pkg/locales';
 *   t(k.auth.errors.invalidCredentials)
 *
 * Backend:
 *   throw new UnauthorizedException(k.auth.errors.invalidCredentials)
 */
export { admin } from './admin';
export { auth } from './auth';
export { users } from './users';
export { orgs } from './orgs';
export { jobs } from './jobs';
export { notifications } from './notifications';
export { mcp } from './mcp';
export { common } from './common';
export { validation } from './validation';
export { tasks } from './tasks';
export { servers } from './servers';
export { environments } from './environments';
export { attachments } from './attachments';

// Combined keys object for convenience
import { admin } from './admin';
import { auth } from './auth';
import { users } from './users';
import { orgs } from './orgs';
import { jobs } from './jobs';
import { notifications } from './notifications';
import { mcp } from './mcp';
import { common } from './common';
import { validation } from './validation';
import { tasks } from './tasks';
import { servers } from './servers';
import { environments } from './environments';
import { attachments } from './attachments';

export const k = {
  admin,
  auth,
  users,
  orgs,
  jobs,
  notifications,
  mcp,
  common,
  validation,
  tasks,
  servers,
  environments,
  attachments,
} as const;
