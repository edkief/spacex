import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { padsForSystem } from '@shared/world/pads';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { requireAuth } from './auth';
import type { RouteDeps } from './callsigns';

/**
 * Dev-only test endpoints (TASK-29 e2e), registered ONLY outside production
 * (vite dev / the e2e harness run tsx directly; a production build sets
 * NODE_ENV=production and the routes never exist):
 *
 * - GET  /api/dev/pad-target — the deterministic landing target: the first
 *   system (star order) hosting a landable ATMOsphere planet, with its pad
 *   position. Lets the e2e fly to a real seeded pad without hardcoding
 *   seed-derived ids.
 * - POST /api/dev/teleport   — the e2e teleport-assist: hard-sets the
 *   caller's ship position in whatever system its shard is active in
 *   (shard.teleportForTesting). No production surface, no persistence.
 * - POST /api/dev/deposit    — TASK-33 e2e assist: places a deposit at an
 *   exact position in the caller's system shard (shard.addDepositForTesting)
 *   so the interaction flow has an interactable before TASK-37's seeded
 *   placement lands. No production surface, no persistence.
 */

const teleportBody = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();

const depositBody = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    quantity: z.number().int().finite().positive().max(1000).optional(),
  })
  .strict();

export function registerDevRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const router = deps.galaxyRouter;
  if (!router) return;

  app.get('/api/dev/pad-target', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    for (const star of generateStars(deps.galaxySeed)) {
      const system = generateSystem(deps.galaxySeed, star.id);
      const planet = system.planets.find((p) => p.landable && p.hasAtmosphere);
      if (!planet) continue;
      const pad = padsForSystem(deps.galaxySeed, system).find((p) => p.planetId === planet.id);
      if (pad) {
        return { systemId: system.systemId, planetId: planet.id, padId: pad.padId, pad: pad.pos };
      }
    }
    return reply
      .code(404)
      .send({ code: 'no-pad', message: 'no landable atmospheric planet in the seeded galaxy' });
  });

  app.post('/api/dev/teleport', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = teleportBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({
          code: 'invalid-teleport',
          message: parsed.error.issues[0]?.message ?? 'invalid body',
        });
    }
    const ship = await deps.repo.getShipByOwner(auth.player.id);
    if (!ship) return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    const active = router.active(ship.position.systemId);
    if (!active) {
      return reply
        .code(409)
        .send({ code: 'not-in-system', message: 'ship system has no active shard' });
    }
    if (!active.shard.teleportForTesting(auth.player.id, parsed.data)) {
      return reply
        .code(409)
        .send({ code: 'teleport-failed', message: 'ship entity not in the shard' });
    }
    return { ok: true, systemId: ship.position.systemId };
  });

  app.post('/api/dev/deposit', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = depositBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({
          code: 'invalid-deposit',
          message: parsed.error.issues[0]?.message ?? 'invalid body',
        });
    }
    const ship = await deps.repo.getShipByOwner(auth.player.id);
    if (!ship) return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    const active = router.active(ship.position.systemId);
    if (!active) {
      return reply
        .code(409)
        .send({ code: 'not-in-system', message: 'ship system has no active shard' });
    }
    const depositId = active.shard.addDepositForTesting(
      { x: parsed.data.x, y: parsed.data.y, z: parsed.data.z },
      parsed.data.quantity ?? 1,
    );
    return { ok: true, depositId, systemId: ship.position.systemId };
  });
}
