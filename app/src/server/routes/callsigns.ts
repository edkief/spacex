import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { callsignSchema } from '@shared/callsign.ts';
import { pickSpawnSystem, type SpawnSystem } from '@shared/galaxy/spawn.ts';
import type { AuthService } from '../auth/service.ts';
import { CallsignTakenError } from '../db/errors.ts';
import type { Repository } from '../db/types.ts';
import { LIMITS } from '../limits.ts';
import { SlidingWindowLimiter } from '../ratelimit.ts';
import { parseOr400, sendError } from '../rest.ts';

const claimSchema = z.strictObject({ callsign: callsignSchema });

export interface CallsignRouteDeps {
  repo: Repository;
  auth: AuthService;
  spawns: readonly SpawnSystem[];
  clock: () => number;
}

/**
 * POST /api/callsigns: claims a callsign (stored UPPERCASE, so uniqueness is case-insensitive),
 * creates the player with a starter ship at a deterministic home system, and returns a session
 * token. All three writes share one transaction so a failure never leaves a half-made player.
 * Claims are rate limited per client IP (callsign squatting is the obvious abuse).
 */
export function registerCallsignRoutes(app: FastifyInstance, deps: CallsignRouteDeps): void {
  const limiter = new SlidingWindowLimiter(
    LIMITS.claimsPerMinute,
    LIMITS.claimWindowMs,
    deps.clock,
  );

  app.post('/api/callsigns', async (request, reply) => {
    if (!limiter.tryAcquire(request.ip)) {
      void reply.header('retry-after', String(LIMITS.claimWindowMs / 1000));
      return sendError(reply, 429, 'rate-limited', 'too many claims; try again later');
    }
    const body = parseOr400(claimSchema, request.body, request, reply);
    if (!body) return reply;

    const playerId = randomUUID();
    const home = pickSpawnSystem(deps.spawns, playerId);
    try {
      const result = await deps.repo.transaction(async (tx) => {
        const player = await tx.createPlayer({
          id: playerId,
          callsign: body.callsign,
          homeSystemId: home.systemId,
        });
        const ship = await tx.getOrCreateStarterShip(player.id);
        const issued = await deps.auth.issue(player.id, tx);
        return { player, ship, issued };
      });
      return reply.code(201).send({
        callsign: result.player.callsign,
        token: result.issued.token,
        playerId: result.player.id,
        homeSystemId: result.player.homeSystemId,
        shipId: result.ship.id,
        expiresAt: result.issued.expiresAt,
      });
    } catch (error) {
      if (error instanceof CallsignTakenError) {
        return sendError(reply, 409, 'callsign-taken', 'callsign already taken');
      }
      throw error;
    }
  });
}
