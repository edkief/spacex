import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth';
import type { RouteDeps } from './callsigns';
import { applySettingsUpdate, SettingsUpdateSchema } from '@shared/settings';

/**
 * /api/players routes (TASK-41 + TASK-55). v1 exposes only the caller's own
 * record — GET /api/players/me (auth) returns the player profile including
 * the credit balance. No endpoint addresses other players by id, so one
 * player's balance is never visible to another.
 *
 * TASK-55: GET/PUT /api/players/settings — the per-player settings row
 * (quality preset / sensitivity / reduced motion). GET returns the stored
 * row (factory defaults for a never-saved player). PUT is a PARTIAL update
 * (zod-validated: a bad quality preset is a 400, an out-of-range
 * sensitivity is CLAMPED, unknown fields are rejected) and returns the new
 * full row.
 */
export function registerPlayerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/players/settings', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    return deps.repo.getPlayerSettings(auth.player.id);
  });

  app.put('/api/players/settings', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const parsed = SettingsUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // Bad quality preset, non-numeric sensitivity, or an unknown field.
      return reply.code(400).send({ code: 'invalid-settings', errors: parsed.error.issues });
    }
    const stored = await deps.repo.getPlayerSettings(auth.player.id);
    const next = applySettingsUpdate(stored, parsed.data);
    await deps.repo.updatePlayerSettings(auth.player.id, next);
    return next;
  });

  app.get('/api/players/me', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const player = auth.player;
    // Idempotent: returns the existing ship when the player has one.
    const ship = await deps.repo.getOrCreateStarterShip(player.id, { classId: 'scout' });
    return {
      callsign: player.callsign,
      credits: player.credits,
      homeSystemId: player.homeSystemId,
      shipId: ship.id,
    };
  });
}
