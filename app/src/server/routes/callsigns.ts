import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { callsignSchema } from '@shared/callsign';
import { homeSystemIdForPlayer } from '@shared/galaxy/home';
import { homeDockPosition } from '@shared/galaxy/dock';
import { SHIP_CLASSES } from '@shared/ships';
import { CallsignTakenError } from '@server/db/errors';
import type { Repository } from '@server/db/repo';
import type { ShipSwapBus } from '@server/shards';
import type { SessionService } from '@server/auth/session';
import type { GalaxyRouter } from '@server/galaxy/router';

/** TASK-56: availability-probe rate limit (per client IP). */
const AVAILABILITY_RATE = 10; // requests/second sustained
const AVAILABILITY_BURST = 20; // instant allowance before 429

const availabilityQuery = z.object({ callsign: z.string().min(1).max(32) }).strict();

/** Refill-on-read token bucket for one client (mirrors ratelimit.ts' bucket). */
class AvailabilityBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly now: () => number) {
    this.tokens = AVAILABILITY_BURST;
    this.last = this.now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(AVAILABILITY_BURST, this.tokens + ((t - this.last) / 1000) * AVAILABILITY_RATE);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface RouteDeps {
  repo: Repository;
  sessions: SessionService;
  galaxySeed: string;
  /** TASK-20: in-process ship-swap bus (shard notification after purchases). */
  shipSwapBus?: ShipSwapBus;
  /** TASK-11: galaxy router (enables GET /api/galaxy/health). */
  galaxyRouter?: GalaxyRouter;
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

    // Starter ship spawns docked at the home system dock (seed-derived
    // coords), hull/shields at the class caps.
    const scout = SHIP_CLASSES.scout;
    const ship = await deps.repo.getOrCreateStarterShip(player.id, {
      classId: 'scout',
      position: { systemId: homeSystemId, ...homeDockPosition(deps.galaxySeed, homeSystemId) },
      hull: scout.hull,
      shields: scout.shieldCapacity,
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

  /**
   * GET /api/callsigns/availability?callsign= — the claims screen's live
   * availability probe (TASK-56). Kept dumb by design: format check + unique
   * check, rate-limited per client IP (10/s, burst 20 → 429). The debouncing
   * (500 ms) lives client-side.
   */
  const buckets = new Map<string, AvailabilityBucket>();
  app.get('/api/callsigns/availability', async (req, reply) => {
    const parsed = availabilityQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'invalid-callsign', message: 'callsign query required' });
    }
    const key = req.ip;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new AvailabilityBucket(Date.now);
      buckets.set(key, bucket);
    }
    if (!bucket.take()) {
      return reply.code(429).send({ code: 'rate-limited', message: 'too many availability probes' });
    }
    const format = callsignSchema.safeParse(parsed.data.callsign);
    if (!format.success) {
      return { available: false as const, reason: 'invalid-format' as const };
    }
    const existing = await deps.repo.findPlayerByCallsign(format.data);
    return { available: existing === undefined, reason: existing === undefined ? undefined : 'taken' };
  });
}
