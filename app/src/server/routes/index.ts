import type { FastifyInstance } from 'fastify';
import { registerCallsignRoutes, type RouteDeps } from './callsigns';
import { registerPlayerRoutes } from './players';
import { registerSessionRoutes } from './session';
import { registerShipRoutes } from './ships';
import { registerGalaxyRoutes } from './galaxy';
import { registerDevRoutes } from './dev';

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
  // TASK-29: dev-only test endpoints (pad-target / teleport) — never in prod.
  if (process.env.NODE_ENV !== 'production') registerDevRoutes(app, deps);
}
