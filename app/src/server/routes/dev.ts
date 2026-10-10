import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { RESOURCE_IDS } from '@shared/inventory';
import { hazardsFor } from '@shared/world/hazards';
import { padsForSystem } from '@shared/world/pads';
import { terminalsFor } from '@shared/world/terminals';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem, systemForId } from '@shared/galaxy/system';
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
 *   caller's ship position (and, optionally, its velocity — the TASK-95
 *   VTOL-approach e2e) in whatever system its shard is active in
 *   (shard.teleportForTesting). No production surface, no persistence.
 * - POST /api/dev/deposit    — TASK-33 e2e assist: places a deposit at an
 *   exact position in the caller's system shard (shard.addDepositForTesting)
 *   so the interaction flow has an interactable before TASK-37's seeded
 *   placement lands. No production surface, no persistence.
 * - POST /api/dev/give       — TASK-34 e2e assist: grants inventory units to
 *   the caller (shard.giveInventoryForTesting — the real earn path is
 *   pickup/mining, TASK-38). No production surface, no persistence.
 * - GET  /api/dev/hazard-target — TASK-48.2 e2e assist: the deterministic
 *   FIRST storm cell (hazardsFor scan, star order, same style as pad-target)
 *   as {systemId, planetId, hazardId, pos, radius}. Lets the e2e warp there
 *   and teleport-char into it (drain the exposure pool) without hardcoding
 *   seed-derived ids. No production surface, no persistence.
 */

const teleportBody = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    // TASK-95: optional inbound velocity (the VTOL-approach e2e starts the
    // ship with a dead-stick velocity aimed at the pad — the approach is
    // momentum-carried by design, exactly as the shard.pads.approach unit
    // test; the atmosphere gained a main thruster in TASK-98, but the e2e
    // seeds the glide's momentum instead of thrusting it in).
    vel: z
      .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
      .strict()
      .optional(),
  })
  .strict();

const depositBody = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    quantity: z.number().int().finite().positive().max(1000).optional(),
    // TASK-38: the resource a mine awards (defaults to iron — the client's
    // prompt + '+1 <resource>' float read it off the deposit entity).
    resourceId: z.enum(RESOURCE_IDS).optional(),
  })
  .strict();

const dummyBody = z
  .object({ distance: z.number().finite().positive().max(450).optional() })
  .strict();

const combatKillBody = z
  .object({
    victim: z.string().min(1).max(64),
    weapon: z.enum(['laser', 'missile']).optional(),
  })
  .strict();

const giveBody = z
  .object({
    resourceId: z.enum(RESOURCE_IDS),
    amount: z.number().int().finite().positive().max(10_000),
  })
  .strict();

// (System resolution by id reuses @shared/galaxy/system's systemForId —
//  the same pure seeded scan the shards use.)

export function registerDevRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const router = deps.galaxyRouter;
  if (!router) return;

  app.get('/api/dev/pad-target', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    // TASK-54: ?systemId= scopes the lookup to ONE system (the keyboard
    // e2e warps through its home system and docks at a pad THERE — the
    // chart only exposes a system's neighbors, so the star-order first pad
    // is generally not reachable by keyboard warp from an arbitrary home).
    const wanted = (req.query as { systemId?: unknown }).systemId;
    if (typeof wanted === 'string' && wanted.length > 0) {
      const system = systemForId(deps.galaxySeed, wanted);
      const planet = system?.planets.find((p) => p.landable && p.hasAtmosphere);
      const pad =
        system && planet
          ? padsForSystem(deps.galaxySeed, system).find((p) => p.planetId === planet.id)
          : undefined;
      if (!pad) {
        return reply
          .code(404)
          .send({ code: 'no-pad', message: `system ${wanted} has no landable atmospheric pad` });
      }
      return { systemId: system!.systemId, planetId: planet!.id, padId: pad.padId, pad: pad.pos };
    }
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

  // TASK-48.2 e2e assist: the deterministic FIRST storm cell in star order
  // (hazardsFor is a pure seeded function — the same cells the shard
  // enforces server-side). The e2e warps to the cell's system, disembarks,
  // and teleports the on-foot character into it (POST /api/dev/teleport-char
  // already exists below) to trigger the exposure drain.
  app.get('/api/dev/hazard-target', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    // TASK-52: ?kind=radzone selects the first rad zone (the exposure-meter
    // e2e); the default 'storm' keeps the TASK-48 e2e byte-identical.
    const kind = (req.query as { kind?: unknown }).kind === 'radzone' ? 'radzone' : 'storm';
    for (const star of generateStars(deps.galaxySeed)) {
      const system = generateSystem(deps.galaxySeed, star.id);
      const cell = hazardsFor(deps.galaxySeed, system).find((h) => h.kind === kind);
      if (cell) {
        return {
          systemId: system.systemId,
          planetId: cell.planetId,
          hazardId: cell.hazardId,
          pos: cell.pos,
          radius: cell.radius,
        };
      }
    }
    return reply
      .code(404)
      .send({ code: 'no-hazard', message: `no ${kind} cell in the seeded galaxy` });
  });

  // TASK-40 e2e assist: the station SELL terminal's world position for the
  // pad target (derived exactly like the pads/terminals the shard spawns).
  // Lets the e2e park the on-foot character at the terminal (within the 3 m
  // interact range AND the 10 m sell range) without simulating the walk.
  app.get('/api/dev/terminal-target', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    // TASK-54: ?systemId= scopes the lookup (same contract as pad-target).
    const wanted = (req.query as { systemId?: unknown }).systemId;
    if (typeof wanted === 'string' && wanted.length > 0) {
      const system = systemForId(deps.galaxySeed, wanted);
      const planet = system?.planets.find((p) => p.landable && p.hasAtmosphere);
      const pad =
        system && planet
          ? padsForSystem(deps.galaxySeed, system).find((p) => p.planetId === planet.id)
          : undefined;
      const terminal =
        system && pad
          ? terminalsFor(deps.galaxySeed, system).find((t) => t.padId === pad.padId)
          : undefined;
      if (!terminal) {
        return reply
          .code(404)
          .send({ code: 'no-terminal', message: `system ${wanted} has no station terminal` });
      }
      return { systemId: system!.systemId, terminalId: terminal.terminalId, pos: terminal.pos };
    }
    for (const star of generateStars(deps.galaxySeed)) {
      const system = generateSystem(deps.galaxySeed, star.id);
      const planet = system.planets.find((p) => p.landable && p.hasAtmosphere);
      if (!planet) continue;
      const pad = padsForSystem(deps.galaxySeed, system).find((p) => p.planetId === planet.id);
      if (!pad) continue;
      const terminal = terminalsFor(deps.galaxySeed, system).find((t) => t.padId === pad.padId);
      if (terminal) {
        return { systemId: system.systemId, terminalId: terminal.terminalId, pos: terminal.pos };
      }
    }
    return reply
      .code(404)
      .send({ code: 'no-terminal', message: 'no station terminal in the seeded galaxy' });
  });

  // TASK-40 e2e assist: teleport the caller's ON-FOOT character to an exact
  // position (shard.teleportCharacterForTesting). The real movement path is
  // the on-foot walker; this parks the character at the terminal for the
  // dock-sell e2e. No production surface, no persistence.
  app.post('/api/dev/teleport-char', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = teleportBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
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
    if (!active.shard.teleportCharacterForTesting(auth.player.id, parsed.data)) {
      return reply.code(409).send({
        code: 'teleport-failed',
        message: 'no on-foot character in the shard (not disembarked?)',
      });
    }
    return { ok: true, systemId: ship.position.systemId };
  });

  app.post('/api/dev/teleport', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = teleportBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
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
    const { x, y, z, vel } = parsed.data;
    if (!active.shard.teleportForTesting(auth.player.id, { x, y, z }, vel)) {
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
      return reply.code(400).send({
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
      parsed.data.resourceId ?? 'iron',
    );
    return { ok: true, depositId, systemId: ship.position.systemId };
  });

  // TASK-34 e2e assist: grant inventory units to the caller (the weight bar
  // needs units to display before TASK-38's mining path lands).
  app.post('/api/dev/give', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = giveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'invalid-give',
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
    active.shard.giveInventoryForTesting(auth.player.id, {
      [parsed.data.resourceId]: parsed.data.amount,
    });
    return { ok: true, systemId: ship.position.systemId };
  });

  // TASK-44 e2e assist: a static ai-ship dummy directly ahead of the
  // caller's ship (shard.spawnDummyTargetForTesting) — a live ship-shaped
  // target for the lock-on flow without a second player. No production
  // surface, no persistence.
  app.post('/api/dev/dummy-target', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = dummyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'invalid-dummy',
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
    const targetId = active.shard.spawnDummyTargetForTesting(
      auth.player.id,
      parsed.data.distance ?? 200,
    );
    if (!targetId) {
      return reply
        .code(409)
        .send({ code: 'no-ship-entity', message: 'ship entity not in the shard' });
    }
    return { ok: true, targetId, systemId: ship.position.systemId };
  });

  // TASK-50 e2e assist: broadcast a 'kill' combat_event with the CALLER as
  // the killer (shard.broadcastKillForTesting — the scripted combat scene
  // for the kill-feed screenshot; the real path is the server's killing hit).
  // No production surface, no persistence.
  app.post('/api/dev/combat-kill', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) return reply.code(401).send({ code: 'unauthorized', reason: auth.reason });
    const parsed = combatKillBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'invalid-kill',
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
    active.shard.broadcastKillForTesting(
      auth.player.id,
      parsed.data.victim,
      parsed.data.weapon ?? 'laser',
    );
    return { ok: true, systemId: ship.position.systemId };
  });
}
