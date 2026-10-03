/**
 * Surface hazards (TASK-48) — the deterministic per-planet hazard cells
 * (storms, rad zones, hostile drone cells) + the pure player-exposure math,
 * shared verbatim by server (authority) and client (markers/meters).
 *
 * Positions are DERIVED, never stored (PRD §6, same contract as deposits):
 * `hazardsFor` is a pure function of (galaxySeed, system) — identical on
 * client and server — so neither side needs wire data for the discs.
 *
 * Contract (AC):
 * - up to HAZARD_MAX_PER_PLANET (8) hazard cells per planet;
 * - {hazardId, planetId, kind: 'storm'|'radzone'|'drones', pos, radius
 *   (100-400 m), intensity, droneCount (drones cells: 2-4)};
 * - deterministic per seed; NO hazard disc inside HAZARD_SAFE_ZONE_M (300 m)
 *   of a settlement/station pad (safe zones); min center spacing 250 m.
 *
 * v1 damage model (documented per task notes):
 * - players have no on-foot HP; hazards drain a personal 'exposure' shield
 *   pool (max 50, regens 5/s OUTSIDE hazards) — the SHIP is never damaged by
 *   storms in v1;
 * - storm: 2/s drain while inside; rad zone: 5/s;
 * - exposure 0 → 'recovering' (cannot move/interact) for RECOVER_MS (5 s),
 *   'SHIELD BURN' — on-foot 'death' does not exist in v1;
 * - drones (surface-only threat, they ignore ships): aggro the nearest
 *   on-foot player within 80 m, hit for 3 through the shared damage pipeline
 *   (source {kind:'drone'}) every 2 s at ≤ 30 m, 20 hull, 180 s respawn.
 * - `intensity` is a visual severity tier (particle density / glow, 1.0-2.0);
 *   the DRAIN RATES are fixed per kind (the AC's 2/s and 5/s are exact).
 * - The exposure pool is per-player and does NOT persist (it resets on
 *   respawn/warp — a tactical resource, not inventory).
 */

import { Rng, hash2, seedFromString } from '../random';
import { CELL_SIZE_M, heightfieldChannels } from '../galaxy/surface';
import { planetAnchor } from '../galaxy/planets';
import { padsForSystem } from './pads';
import type { Planet, SystemGen } from '../galaxy/types';
import type { Vec3 } from '../physics/vec';

export const HAZARD_KINDS = ['storm', 'radzone', 'drones'] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];

/** Hard cap on hazard cells per planet (AC). */
export const HAZARD_MAX_PER_PLANET = 8;
/** Seeded radius range (inclusive, m). */
export const HAZARD_RADIUS_MIN = 100;
export const HAZARD_RADIUS_MAX = 400;
/** No hazard disc inside this many metres of a pad center (safe zones, AC). */
export const HAZARD_SAFE_ZONE_M = 300;
/** Min center spacing between two cells on the same planet (m). */
export const HAZARD_MIN_SPACING_M = 250;
/** Scatter radius (m) around the planet's surface anchor. */
export const HAZARD_SCATTER_RADIUS_M = 2_000;
/** Client marker + entity streaming range (m, AC step 3). */
export const HAZARD_RENDER_RANGE_M = 500;

// --- Exposure pool ---------------------------------------------------------

/** Max personal exposure (shield) points (AC). */
export const EXPOSURE_MAX = 50;
/** Storm drain (points/s) while inside a storm cell (AC: 2/s). */
export const STORM_DRAIN_PER_S = 2;
/** Rad-zone drain (points/s) while inside a rad cell (AC: 5/s). */
export const RAD_DRAIN_PER_S = 5;
/** Regen (points/s) while OUTSIDE hazards (AC). */
export const EXPOSURE_REGEN_PER_S = 5;
/** Knock-down duration in ms (AC: 5 s 'SHIELD BURN' / 'RECOVERING'). */
export const RECOVER_MS = 5_000;

// --- Drones ----------------------------------------------------------------

/** Aggro radius: nearest on-foot player (m, AC). */
export const DRONE_AGGRO_RADIUS_M = 80;
/** Attack range (m, AC). */
export const DRONE_FIRE_RADIUS_M = 30;
/** Damage per drone hit (points, AC — weak by design). */
export const DRONE_HIT_DAMAGE = 3;
/** Fire cadence (ms, AC). */
export const DRONE_FIRE_INTERVAL_MS = 2_000;
/** Drone hull points (AC). */
export const DRONE_HULL = 20;
/** Respawn delay after a kill (ms, AC). */
export const DRONE_RESPAWN_MS = 180_000;
/** Seeded drones per drone cell (AC: 2-4). */
export const DRONE_MIN_PER_CELL = 2;
export const DRONE_MAX_PER_CELL = 4;
/** Chase speed (m/s). */
export const DRONE_CHASE_SPEED = 5;
/** Patrol orbit angular speed (rad/s). */
export const DRONE_ORBIT_SPEED = 0.3;
/** Hover height above the cell's ground height (m). */
export const DRONE_HOVER_M = 2;

/** One seeded hazard cell (the client derives the SAME list from the seed). */
export interface Hazard {
  /** Stable seed-derived id `${systemId}:hz:${seq}`. */
  hazardId: string;
  planetId: string;
  kind: HazardKind;
  /** World position of the cell center; y = terrain height at (x, z). */
  pos: Vec3;
  /** Disc radius (m, 100-400). */
  radius: number;
  /** Visual severity tier: one of 1.0 / 1.5 / 2.0 (see module docs). */
  intensity: number;
  /** Seeded drone count — ONLY meaningful for kind 'drones' (2-4). */
  droneCount: number;
}

/**
 * The player-facing hazard frame state (per-player, NON-persistent).
 * `recoveringUntilMs` is an epoch-ms deadline (0 = not recovering).
 */
export interface ExposureState {
  exposure: number;
  recoveringUntilMs: number;
}

/** Fresh state: full pool, not recovering. */
export const FULL_EXPOSURE: ExposureState = { exposure: EXPOSURE_MAX, recoveringUntilMs: 0 };

/** The two exposure-draining hazard kinds (drones hit via the pipeline). */
export type DrainKind = 'storm' | 'radzone';

/**
 * PURE exposure-pool tick (AC step 1, unit-tested for exact knock-down
 * timing): drain inside a cell (storm 2/s, rad 5/s — FIXED per kind), regen
 * 5/s outside, clamp to [0, EXPOSURE_MAX]. Knock-down: the tick in which the
 * drain brings exposure to 0 sets `recoveringUntilMs = nowMs + RECOVER_MS`
 * and reports `knocked: true` (the shard freezes the character + prompts
 * 'SHIELD BURN'). No regen while recovering; `knocked` fires exactly once
 * per knock-down.
 */
export function tickExposure(
  state: ExposureState,
  inside: DrainKind | null,
  dtSec: number,
  nowMs: number,
): { state: ExposureState; knocked: boolean } {
  if (nowMs < state.recoveringUntilMs) return { state, knocked: false };
  if (inside === null) {
    const exposure = Math.min(EXPOSURE_MAX, state.exposure + EXPOSURE_REGEN_PER_S * dtSec);
    return { state: { exposure, recoveringUntilMs: 0 }, knocked: false };
  }
  const rate = inside === 'storm' ? STORM_DRAIN_PER_S : RAD_DRAIN_PER_S;
  const exposure = state.exposure - rate * dtSec;
  if (exposure <= 0) {
    return {
      state: { exposure: 0, recoveringUntilMs: nowMs + RECOVER_MS },
      knocked: true,
    };
  }
  return { state: { exposure, recoveringUntilMs: 0 }, knocked: false };
}

/**
 * The hazard cell `pos` stands in, if any (horizontal xz distance ≤ radius,
 * same planet only). Returns undefined when clear — the caller regens.
 */
export function hazardAt(hazards: Hazard[], pos: Vec3, planetId: string): Hazard | undefined {
  for (const h of hazards) {
    if (h.planetId !== planetId) continue;
    if (Math.hypot(pos.x - h.pos.x, pos.z - h.pos.z) <= h.radius) return h;
  }
  return undefined;
}

/** Scatter radius in cells (cell-aligned candidate grid, like deposits). */
const HAZARD_CELL_RANGE = Math.floor(HAZARD_SCATTER_RADIUS_M / CELL_SIZE_M);
/** Rejection attempts per due cell (bounded Poisson-ish thinning). */
const HAZARD_ATTEMPTS_PER_CELL = 24;

/** Per-system cache: derivation touches the noise channels and is not free. */
const hazardCache = new Map<string, Hazard[]>();

/** Test hook: clear the per-system cache (cold-derivation determinism tests). */
export function __resetHazardCache(): void {
  hazardCache.clear();
}

/**
 * Eligible terrain: solid surfaces only — landable, not oceans (no rad
 * zones underwater), not gas giants (no surface). Same eligibility as the
 * deposit scatter.
 */
function isHazardPlanet(planet: Planet): boolean {
  return planet.landable && planet.class !== 'ocean' && planet.class !== 'gas';
}

/**
 * Scatter the cells DUE to one planet around its surface anchor. Pure and
 * deterministic in (galaxySeed, systemId, planet, index): cell-aligned
 * world candidates, rejected when any corner of the DISC would fall inside
 * HAZARD_SAFE_ZONE_M of a pad (the 300 m safe zone — stronger than the
 * spec's center rule, so a pad is never ringed by hazard), or closer than
 * HAZARD_MIN_SPACING_M to an accepted neighbor.
 */
function scatterPlanet(
  galaxySeed: string,
  systemId: string,
  planet: Planet,
  index: number,
  due: number,
  pads: Array<{ x: number; z: number }>,
): Array<{ pos: Vec3; radius: number }> {
  const anchor = planetAnchor(index);
  const sub = hash2(
    hash2(seedFromString(galaxySeed), seedFromString(systemId)),
    seedFromString(`hazards:${planet.id}`),
  );
  const rng = new Rng(sub);
  const { height, amp } = heightfieldChannels(galaxySeed, planet);
  const cells = new Map<string, number>();
  const cell = (cellX: number, cellZ: number): number => {
    const key = cellX + ',' + cellZ;
    let v = cells.get(key);
    if (v === undefined) {
      v = Math.round(height.fbm01(cellX, cellZ) * amp);
      cells.set(key, v);
    }
    return v;
  };
  const hAt = (x: number, z: number): number => {
    const fx = x / CELL_SIZE_M;
    const fz = z / CELL_SIZE_M;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const tx = fx - cx;
    const tz = fz - cz;
    const top = cell(cx, cz) + (cell(cx + 1, cz) - cell(cx, cz)) * tx;
    const bottom = cell(cx, cz + 1) + (cell(cx + 1, cz + 1) - cell(cx, cz + 1)) * tx;
    return top + (bottom - top) * tz;
  };
  const anchorCellX = Math.floor(anchor.x / CELL_SIZE_M);
  const anchorCellZ = Math.floor(anchor.z / CELL_SIZE_M);
  const accepted: Array<{ pos: Vec3; radius: number }> = [];
  const tries = Math.min(4000, due * HAZARD_ATTEMPTS_PER_CELL);
  for (let i = 0; i < tries && accepted.length < due; i++) {
    const radius = HAZARD_RADIUS_MIN + rng.nextInt(HAZARD_RADIUS_MAX - HAZARD_RADIUS_MIN + 1);
    const cellX = anchorCellX + rng.nextInt(HAZARD_CELL_RANGE * 2 + 1) - HAZARD_CELL_RANGE;
    const cellZ = anchorCellZ + rng.nextInt(HAZARD_CELL_RANGE * 2 + 1) - HAZARD_CELL_RANGE;
    const x = cellX * CELL_SIZE_M;
    const z = cellZ * CELL_SIZE_M;
    // Safe zones first (the whole disc stays >= 300 m from every pad).
    const unsafe = pads.some((p) => Math.hypot(p.x - x, p.z - z) < HAZARD_SAFE_ZONE_M + radius);
    if (unsafe) continue;
    const tooClose = accepted.some(
      (p) => Math.hypot(p.pos.x - x, p.pos.z - z) < HAZARD_MIN_SPACING_M,
    );
    if (tooClose) continue;
    accepted.push({ pos: { x, y: hAt(x, z), z }, radius });
  }
  return accepted;
}

/**
 * The system's deterministic hazard list (AC): up to 8 cells per eligible
 * planet, seeded radii 100-400 m, none inside the 300 m pad safe zones,
 * 250 m apart. Cached per (seed, systemId).
 *
 * Hazard ids are STABLE across restarts — `${systemId}:hz:${seq}` — in
 * orbital/acceptance order, so server and client always agree.
 */
export function hazardsFor(
  galaxySeed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): Hazard[] {
  const key = `${galaxySeed}\u0000${system.systemId}`;
  const cached = hazardCache.get(key);
  if (cached) return cached;

  const pads = padsForSystem(galaxySeed, system);
  const eligible: Array<{ planet: Planet; index: number }> = [];
  system.planets.forEach((planet, index) => {
    if (isHazardPlanet(planet)) eligible.push({ planet, index });
  });

  const kindRng = new Rng(
    hash2(
      hash2(seedFromString(galaxySeed), seedFromString(system.systemId)),
      seedFromString('hazards'),
    ),
  );
  const out: Hazard[] = [];
  let seq = 0;
  eligible.forEach(({ planet, index }) => {
    const planetPads = pads
      .filter((p) => p.planetId === planet.id)
      .map((p) => ({ x: p.pos.x, z: p.pos.z }));
    const cells = scatterPlanet(galaxySeed, system.systemId, planet, index, HAZARD_MAX_PER_PLANET, planetPads);
    for (const { pos, radius } of cells) {
      const kind = HAZARD_KINDS[rngInt(kindRng, HAZARD_KINDS.length)];
      out.push({
        hazardId: `${system.systemId}:hz:${seq}`,
        planetId: planet.id,
        kind,
        pos,
        radius,
        intensity: 1 + kindRng.nextInt(3) * 0.5,
        droneCount: kind === 'drones' ? DRONE_MIN_PER_CELL + kindRng.nextInt(3) : 0,
      });
      seq += 1;
    }
  });
  hazardCache.set(key, out);
  return out;
}

/** Uniform int in [0, n) — Rng.nextInt alias kept local for readability. */
function rngInt(rng: Rng, n: number): number {
  return rng.nextInt(n);
}
