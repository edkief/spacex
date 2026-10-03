/**
 * Rogue AI ship rosters (TASK-45) — the deterministic per-system pirate
 * roster, shared verbatim by server and client.
 *
 * Every star system carries 6-10 rogue AI ships ("pirates") patrolling its
 * open space. The roster is DERIVED, never stored (PRD §6): `rosterFor` is
 * a pure function of (galaxySeed, system) — identical on client and server —
 * and rogues are a RENEWABLE threat: the shard holds their live state
 * (hull/damage, respawn timers) only while it lives; on shard reap the
 * roster is re-derived to full on the next spawn (no persistence row exists
 * for an ai-ship — shard/persist.ts skips them by kind).
 *
 * Contract (AC):
 * - 6..10 ships per system, class weights scout 50 / interceptor 35 /
 *   freighter 15 (stats come from shipStats — this module only picks);
 * - spawnPos: seeded in the y=0 plane, 500..3000 u from the star (the
 *   in-system star always sits at the ORIGIN — spawn.ts); rejected when
 *   inside a planet's atmosphere sphere (the planets' anchors carry the
 *   1 km atmosphere, planetAtmosphereRadius) or within MIN_STATION_DIST_U
 *   (200 u) of a station anchor;
 * - "stations": the sim has no orbital station entity — the station anchors
 *   are the surface settlement PADS (padsForSystem, one per landable planet)
 *   and the home dock (homeDockPosition, within ±100 u of the origin);
 * - patrol: center = spawnPos + a seeded 100..400 u offset, radius 200..800
 *   u (the patrol BEHAVIOR is TASK-46 — this task owns the entities +
 *   respawn state only);
 * - names: no-duplicate picks from the 40 pirate callsigns (all pass the
 *   3-16 char CALLSIGN_PATTERN — rogues look like player callsigns; the
 *   `ai` wire flag is what marks them, TASK-50);
 * - livery: a seeded per-class pirate scheme {hull, accent, trim} (hex —
 *   the wire livery contract), so the future ship layer + lock-on need no
 *   roster-specific rendering.
 *
 * Determinism: one Rng per (galaxySeed, systemId) with the shared sub-seed
 * scheme (hash2 of the galaxy+system seed tagged 'rogues'), fixed draw order
 * per ship. Cached per system like depositsFor; `__resetRosterCache` is the
 * cold-cache test hook.
 */

import { PIRATE_CALLSIGNS } from '../ai/names';
import { homeDockPosition } from '../galaxy/dock';
import { planetAnchor, planetAtmosphereRadius } from '../galaxy/planets';
import { hash2, Rng, seedFromString } from '../random';
import type { Livery, ShipClassId } from '../ships';
import type { SystemGen } from '../galaxy/types';
import type { Vec3 } from '../physics/vec';
import { padsForSystem } from './pads';

/** Roster size bounds (AC: 6-10 rogues per system). */
export const ROGUE_COUNT_MIN = 6;
export const ROGUE_COUNT_MAX = 10;
/** Spawn radius bounds from the star (u, y=0 plane). */
export const ROGUE_SPAWN_RADIUS_MIN = 500;
export const ROGUE_SPAWN_RADIUS_MAX = 3000;
/** Min horizontal distance from any station anchor (u — pads + home dock). */
export const MIN_STATION_DIST_U = 200;
/** Patrol radius bounds (u; the center sits 100..400 u from the spawn). */
export const ROGUE_PATROL_RADIUS_MIN = 200;
export const ROGUE_PATROL_RADIUS_MAX = 800;
/** A destroyed rogue respawns at its spawnPos this long later (server tick). */
export const ROGUE_RESPAWN_MS = 120_000;

/** Bounded placement attempts per ship (deterministic fallback after). */
const SPAWN_ATTEMPTS = 64;

/** Seeded pirate livery palettes (all hex — the wire livery contract). */
const PIRATE_HULLS = ['#2b2f3a', '#33392f', '#3a2f2b', '#2f3a3a', '#3a332b', '#292e3f'] as const;
const PIRATE_ACCENTS = ['#b0413e', '#c07a2c', '#7a8b3c', '#3c6f8a', '#8a3c6b', '#a8912c'] as const;
const PIRATE_TRIMS = ['#14161c', '#1b1d24', '#201a14', '#141b14', '#191420', '#231c12'] as const;

/** One seeded rogue (the client derives the SAME list from the same seed). */
export interface RogueRosterEntry {
  /** Stable seed-derived id `ai:${systemId}:${seq}` — the wire entity id. */
  aiId: string;
  /** Weighted class pick (scout 50 / interceptor 35 / freighter 15). */
  classId: ShipClassId;
  /** No-duplicate pick from PIRATE_CALLSIGNS (passes CALLSIGN_PATTERN). */
  callsign: string;
  /** Seeded y=0-plane position, 500..3000 u from the star (the origin). */
  spawnPos: Vec3;
  /** The patrol anchor: spawnPos + a seeded 100..400 u offset (y=0). */
  patrolCenter: Vec3;
  /** The patrol radius (u; TASK-46 steers it). */
  patrolRadius: number;
  /** Seeded pirate scheme {hull, accent, trim} (hex colors). */
  livery: Livery;
}

/** Per-system cache: derivation touches the pad chunks and is not free. */
const rosterCache = new Map<string, RogueRosterEntry[]>();

/** Test hook: clear the per-system cache (cold-derivation determinism). */
export function __resetRosterCache(): void {
  rosterCache.clear();
}

/** Class weights: scout 50%, interceptor 35%, freighter 15% (AC). */
function pickClass(rng: Rng): ShipClassId {
  const r = rng.nextF64();
  if (r < 0.5) return 'scout';
  if (r < 0.85) return 'interceptor';
  return 'freighter';
}

/** A seeded pirate scheme from the shared palettes (all from one rng). */
function pirateLivery(rng: Rng): Livery {
  return {
    hull: PIRATE_HULLS[rng.nextInt(PIRATE_HULLS.length)],
    accent: PIRATE_ACCENTS[rng.nextInt(PIRATE_ACCENTS.length)],
    trim: PIRATE_TRIMS[rng.nextInt(PIRATE_TRIMS.length)],
  };
}

/**
 * One spawn position in the y=0 plane: seeded angle + radius 500..3000 u
 * from the origin (the star), rejected inside a planet's atmosphere sphere
 * or within MIN_STATION_DIST_U of a station anchor (pads + home dock).
 * Bounded to SPAWN_ATTEMPTS draws, then ACCEPTS THE LAST CANDIDATE — the
 * fallback is deterministic by construction (with planets ≥ 10 000 u out
 * and 1 km atmospheres, rejection can only ever bite inside a small band,
 * but the loop stays total for foreign/corrupt system data).
 */
function spawnPosition(rng: Rng, system: Pick<SystemGen, 'planets'>, stations: Vec3[]): Vec3 {
  const planets = system.planets.map((planet, index) => ({
    anchor: planetAnchor(index),
    atmosphere: planetAtmosphereRadius(planet),
  }));
  let pos: Vec3 = { x: ROGUE_SPAWN_RADIUS_MIN, y: 0, z: 0 };
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const angle = rng.nextF64() * Math.PI * 2;
    const radius = rng.nextRange(ROGUE_SPAWN_RADIUS_MIN, ROGUE_SPAWN_RADIUS_MAX);
    pos = { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius };
    // (a) never inside an atmosphere (rogues are space-only in v1);
    let rejected = planets.some(
      (p) => p.atmosphere > 0 && Math.hypot(pos.x - p.anchor.x, pos.z - p.anchor.z) <= p.atmosphere,
    );
    // (b) never within MIN_STATION_DIST_U of a station anchor (pads/dock).
    if (!rejected) {
      rejected = stations.some((s) => Math.hypot(pos.x - s.x, pos.z - s.z) < MIN_STATION_DIST_U);
    }
    // (c) the radius is in [500, 3000) by construction (nextRange).
    if (!rejected) break;
  }
  return pos;
}

/**
 * The system's deterministic rogue roster (AC): 6-10 ships, weighted
 * classes, no-duplicate pirate callsigns, seeded y=0-plane spawn positions
 * 500..3000 u from the star (never in an atmosphere, ≥ 200 u from a
 * station anchor), seeded patrol parameters + livery. Cached per
 * (seed, systemId).
 */
export function rosterFor(
  galaxySeed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): RogueRosterEntry[] {
  const key = `${galaxySeed}\u0000${system.systemId}`;
  const cached = rosterCache.get(key);
  if (cached) return cached;

  // The station anchors: the settlement pads + the home dock (see header).
  const stations: Vec3[] = [
    ...padsForSystem(galaxySeed, system).map((pad) => pad.pos),
    homeDockPosition(galaxySeed, system.systemId),
  ];

  const rng = new Rng(
    hash2(
      hash2(seedFromString(galaxySeed), seedFromString(system.systemId)),
      seedFromString('rogues'),
    ),
  );
  const count = ROGUE_COUNT_MIN + rng.nextInt(ROGUE_COUNT_MAX - ROGUE_COUNT_MIN + 1);

  // No-duplicate callsigns: pick-and-swap over a copied index array, every
  // draw from the one roster rng (client/server parity).
  const namePool = PIRATE_CALLSIGNS.map((_, i) => i);

  const out: RogueRosterEntry[] = [];
  for (let seq = 0; seq < count; seq++) {
    const classId = pickClass(rng);
    const livery = pirateLivery(rng);
    const draw = rng.nextInt(namePool.length);
    const callsign = PIRATE_CALLSIGNS[namePool[draw]];
    namePool[draw] = namePool[namePool.length - 1];
    namePool.pop();
    const spawnPos = spawnPosition(rng, system, stations);
    // patrolCenter: spawnPos + a seeded 100..400 u offset in the same plane.
    const centerAngle = rng.nextF64() * Math.PI * 2;
    const centerDist = rng.nextRange(100, 400);
    out.push({
      aiId: `ai:${system.systemId}:${seq}`,
      classId,
      callsign,
      spawnPos,
      patrolCenter: {
        x: spawnPos.x + Math.cos(centerAngle) * centerDist,
        y: 0,
        z: spawnPos.z + Math.sin(centerAngle) * centerDist,
      },
      patrolRadius: rng.nextRange(ROGUE_PATROL_RADIUS_MIN, ROGUE_PATROL_RADIUS_MAX),
      livery,
    });
  }
  rosterCache.set(key, out);
  return out;
}
