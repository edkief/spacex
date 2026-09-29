import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { callsignSchema } from '@shared/callsign';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { CallsignTakenError } from '@server/db/errors';
import type { Repository } from '@server/db/repo';
import type { SessionService } from '@server/auth/session';

export interface RouteDeps {
  repo: Repository;
  sessions: SessionService;
  galaxySeed: string;
}

const claimBody = z.object({ callsign: callsignSchema }).strict();

/**
 * POST /api/callsigns — claims a unique callsign and returns the player's
 * first session token (TASK-10). Case-insensitive uniqueness comes from the
 * lowercase transform in the shared schema; the home system is derived
 * deterministically from the (fresh) player id.
 */
export function registerCallsignRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post('/api/callsigns', async (req, reply) => {
    const parsed = claimBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        code: 'invalid-callsign',
        message: issue?.message ?? 'invalid claims body',
      });
    }
    const callsign = parsed.data.callsign;
    const playerId = randomUUID();
    const homeSystemId = homeSystemIdForPlayer(deps.galaxySeed, playerId);

    let player;
    try {
      player = await deps.repo.createPlayer({ callsign, homeSystemId, id: playerId });
    } catch (err) {
      if (err instanceof CallsignTakenError) {
        return reply
          .code(409)
          .send({ code: 'callsign-taken', message: `callsign ${callsign} is already taken` });
      }
      throw err;
    }

    // Starter ship spawns docked at the home system origin.
    const ship = await deps.repo.getOrCreateStarterShip(player.id, {
      classId: 'scout',
      position: { systemId: homeSystemId, x: 0, y: 0, z: 0 },
    });
    const token = await deps.sessions.issue(player.id);
    return reply.code(201).send({
      callsign,
      token,
      playerId: player.id,
      homeSystemId,
      shipId: ship.id,
    });
  });
}
