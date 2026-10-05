/**
 * Landing pads (TASK-29) — the system's seeded pad list + the pure
 * detection / VTOL-assist math the sim (authority) and tests share.
 *
 * Every landable planet's settlement (TASK-4/5: the chunk (0,0) surface
 * pad, which exists exactly once per landable planet by construction) is a
 * flat 40 m circle at a defined height — the "top of the structure". The
 * pad list is a deterministic function of (galaxySeed, system) and is
 * cached per system by the shard (server) and the WorldManager (client).
 *
 * Docking rules (server-authoritative, evaluated in the sim tick):
 * - a ship tracks a pad by horizontal distance with hysteresis: it ACQUIRES
 *   the nearest pad within PAD_RADIUS_M (20 m) and KEEPS it up to
 *   PAD_RELEASE_RADIUS_M (25 m), so a slow ship on the boundary cannot flap;
 * - "docked" additionally needs the surface regime, |vel.y| < 2 u/s and
 *   altitude within 1 m of the pad height (the pad is flat, so a landed
 *   ship satisfies this anywhere on its disc);
 * - takeoff: the dock check re-runs every tick, so vertical speed > 2 u/s
 *   clears the state within one tick (inputs are never locked);
 * - one pad per ship: the state is a single padId (the invariant is
 *   asserted in the sim tests).
 *
 * VTOL assist: while the VTOL key is held, within VTOL_ASSIST_RANGE_M (100 m)
 * of a pad and below VTOL_ASSIST_SPEED_MAX_M_S (50 u/s), horizontal drift is
 * damped × VTOL_ASSIST_DAMPING (0.5) every tick — server-side physics that
 * makes parking possible (the client only renders the pad ring).
 */

import { chunkSeed, generateSurfaceChunk, CHUNK_SIZE, CELL_SIZE_M } from '../galaxy/surface.js';
import { planetAnchor } from '../galaxy/planets.js';
import { hash2, seedFromString } from '../random.js';
import type { SystemGen } from '../galaxy/types.js';
import type { Vec3 } from '../physics/vec.js';

/** Pad disc radius in metres (40 m flat circle; the acquisition range). */
export const PAD_RADIUS_M = 20;
/** Hysteresis: a tracked pad is kept while the ship stays within this. */
export const PAD_RELEASE_RADIUS_M = 25;
/** The pad disc is flat to its radius, blended into the terrain to here. */
export const PAD_FLAT_BLEND_OUTER_M = 30;
/** Max |vel.y| (u/s) for a ship to count as docked. */
export const DOCK_VERTICAL_SPEED_MAX_M_S = 2;
/** Max |altitude − pad height| (m) for a ship to count as docked. */
export const DOCK_ALTITUDE_TOLERANCE_M = 1;
/** VTOL assist range from a pad (m). */
export const VTOL_ASSIST_RANGE_M = 100;
/** VTOL assist applies only below this total speed (u/s). */
export const VTOL_ASSIST_SPEED_MAX_M_S = 50;
/** Per-tick multiplier on horizontal drift while the assist is active. */
export const VTOL_ASSIST_DAMPING = 0.5;

/** One landing pad (server-authoritative state, seeded data). */
export interface PadInfo {
  padId: string;
  planetId: string;
  /** World position of the pad CENTER; y is the (flat) pad surface height. */
  pos: Vec3;
  /** Pad surface normal (planetary surface: up). */
  normal: Vec3;
  /** Flat disc radius (m). */
  radius: number;
}

const PAD_NORMAL: Vec3 = { x: 0, y: 1, z: 0 };

/** Per-system cache: derivation is deterministic and chunk-generation is not free. */
const padCache = new Map<string, PadInfo[]>();

/**
 * The deterministic pad list of a system: exactly one pad per landable
 * planet (its settlement), in orbital-slot order. Cached per (seed, systemId).
 *
 * The settlement LAYOUT (pad id + local xz offset) comes from the planet's
 * chunk (0,0) seeded pad (TASK-5: exactly one per landable planet); its
 * WORLD position is the planet's surface ANCHOR (the atmosphere sits over
 * that anchor — TASK-25) plus the local offset, so the pad always lies
 * inside the planet's atmosphere where a ship can actually reach the
 * surface regime. The pad height is the terrain at that world position.
 */
export function padsForSystem(
  galaxySeed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): PadInfo[] {
  const key = `${galaxySeed}\u0000${system.systemId}`;
  const cached = padCache.get(key);
  if (cached) return cached;
  const out: PadInfo[] = [];
  system.planets.forEach((planet, index) => {
    if (!planet.landable) return;
    const chunk = generateSurfaceChunk(galaxySeed, planet, 0, 0);
    const pad = chunk.landingPads[0];
    // Chunk (0,0) of a landable planet always has exactly one pad (TASK-5);
    // the fallback keeps the list total if a foreign/corrupt chunk ever lacks it.
    const padId =
      pad?.id ??
      hash2(chunkSeed(galaxySeed, planet.id, 0, 0), seedFromString('pad'))
        .toString(16)
        .padStart(16, '0');
    const anchor = planetAnchor(index);
    const x = anchor.x + (pad ? pad.x : (CHUNK_SIZE >> 1) * CELL_SIZE_M);
    const z = anchor.z + (pad ? pad.z : (CHUNK_SIZE >> 1) * CELL_SIZE_M);
    // Terrain height at the pad's world position (the planet-wide field).
    const worldCellX = Math.floor(x / CELL_SIZE_M);
    const worldCellZ = Math.floor(z / CELL_SIZE_M);
    const cX = Math.floor(worldCellX / CHUNK_SIZE);
    const cZ = Math.floor(worldCellZ / CHUNK_SIZE);
    const hChunk = generateSurfaceChunk(galaxySeed, planet, cX, cZ);
    const h =
      hChunk.heightmap[
        (worldCellZ - cZ * CHUNK_SIZE) * CHUNK_SIZE + (worldCellX - cX * CHUNK_SIZE)
      ];
    out.push({
      padId,
      planetId: planet.id,
      pos: { x, y: h, z },
      normal: { ...PAD_NORMAL },
      radius: PAD_RADIUS_M,
    });
  });
  padCache.set(key, out);
  return out;
}

/** Horizontal (xz-plane) distance from a position to a pad center (m). */
export function horizontalDistanceM(pos: Vec3, pad: PadInfo): number {
  return Math.hypot(pos.x - pad.pos.x, pos.z - pad.pos.z);
}

/**
 * Resolve the pad a ship is working with (nearest, with hysteresis):
 * - a TRACKED pad is kept while the ship stays within PAD_RELEASE_RADIUS_M
 *   (the 20–25 m anti-flap band);
 * - otherwise the nearest pad within PAD_RADIUS_M is acquired (ties break
 *   on padId, deterministically);
 * - otherwise no pad.
 * Returns at most ONE pad — a ship can never track two (sim invariant).
 */
export function resolvePadTarget(
  pos: Vec3,
  pads: PadInfo[],
  currentPadId?: string | null,
): PadInfo | undefined {
  const current = currentPadId ? pads.find((p) => p.padId === currentPadId) : undefined;
  if (current && horizontalDistanceM(pos, current) <= PAD_RELEASE_RADIUS_M) return current;
  let best: PadInfo | undefined;
  let bestD = Infinity;
  for (const pad of pads) {
    const d = horizontalDistanceM(pos, pad);
    if (d > PAD_RADIUS_M) continue;
    if (d < bestD || (d === bestD && (!best || pad.padId < best.padId))) {
      best = pad;
      bestD = d;
    }
  }
  return best;
}

/**
 * The full dock condition: within the pad disc, surface regime, vertical
 * speed < 2 u/s, and altitude within 1 m of the pad height.
 */
export function satisfiesDock(pos: Vec3, vel: Vec3, regime: string, pad: PadInfo): boolean {
  if (regime !== 'surface') return false;
  if (horizontalDistanceM(pos, pad) > PAD_RADIUS_M) return false;
  if (Math.abs(vel.y) >= DOCK_VERTICAL_SPEED_MAX_M_S) return false;
  if (Math.abs(pos.y - pad.pos.y) > DOCK_ALTITUDE_TOLERANCE_M) return false;
  return true;
}

/** VTOL assist gate: key held, under the speed cap, within range of a pad. */
export function vtolAssistActive(up: number, speed: number, pos: Vec3, pads: PadInfo[]): boolean {
  if (up <= 0) return false;
  if (speed >= VTOL_ASSIST_SPEED_MAX_M_S) return false;
  return pads.some((p) => horizontalDistanceM(pos, p) <= VTOL_ASSIST_RANGE_M);
}

/** The assist itself: damp the horizontal drift by the per-tick factor. */
export function applyVtolAssist(vel: Vec3): Vec3 {
  return { x: vel.x * VTOL_ASSIST_DAMPING, y: vel.y, z: vel.z * VTOL_ASSIST_DAMPING };
}

/**
 * The pad's terrain override: a flat disc at the pad height inside its
 * radius, blended smoothly (raised cosine) into the real terrain out to
 * PAD_FLAT_BLEND_OUTER_M so a ship gliding over the rim never hits a cliff.
 * The sim's heightAt (flight model AND regime machine) wraps TerrainContext
 * with this, so the pad is flat for physics, regime, and docking alike.
 */
export function padSurfaceHeight(
  x: number,
  z: number,
  groundY: number,
  pad: PadInfo | undefined,
): number {
  if (!pad) return groundY;
  const d = Math.hypot(x - pad.pos.x, z - pad.pos.z);
  if (d >= PAD_FLAT_BLEND_OUTER_M) return groundY;
  if (d <= PAD_RADIUS_M) return pad.pos.y;
  const t = (d - PAD_RADIUS_M) / (PAD_FLAT_BLEND_OUTER_M - PAD_RADIUS_M);
  const s = (1 - Math.cos(Math.PI * t)) / 2;
  return pad.pos.y * (1 - s) + groundY * s;
}
