import type { FastifyInstance } from 'fastify';
import { registerCallsignRoutes, type RouteDeps } from './callsigns';
import { registerPlayerRoutes } from './players';
import { registerSessionRoutes } from './session';
import { registerShipRoutes } from './ships';
import { registerGalaxyRoutes } from './galaxy';

/** All REST routes that need the repo + session service (TASK-10). */
export function registerApiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerCallsignRoutes(app, deps);
  registerPlayerRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerShipRoutes(app, deps);
  if (deps.galaxyRouter) {
    registerGalaxyRoutes(app, {
      sessions: deps.sessions,
      router: deps.galaxyRouter,
      galaxySeed: deps.galaxySeed,
    });
  }
}
