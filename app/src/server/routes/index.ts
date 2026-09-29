import type { FastifyInstance } from 'fastify';
import { registerCallsignRoutes, type RouteDeps } from './callsigns';
import { registerSessionRoutes } from './session';

/** All REST routes that need the repo + session service (TASK-10). */
export function registerApiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerCallsignRoutes(app, deps);
  registerSessionRoutes(app, deps);
}
