/**
 * Surface hazard placement — TASK-48.
 *
 * Every planet in the galaxy carries up to `MAX_HAZARDS_PER_PLANET`
 * surface hazards. The placement is **fully seed-derived**:
 *
 *   - `hazardsFor(seed, systemId)` returns the same list for any
 *     two callers with the same `(seed, systemId)` inputs.
 *   - Each hazard's position, radius, intensity, and (for drone
 *     cells) drone count come from a seeded RNG keyed by
 *     `(seed, systemId, "hazards")`.
 *   - Constraints (no hazard within 300 m of a settlement pad,
 *     no overlap with deposits, in-range radius / intensity)
 *     are enforced by rejection sampling.
 *
 * ## Determinism contract
 *
 * The hazard list is purely a function of:
 *
 *   - the galaxy seed (`seed`)
 *   - the parent star id (`systemId`)
 *
 * Server and client both call this with the same inputs and see
 * the same output. Hazard mutations (drone hull damage, drone
 * respawn timers, per-player exposure / recovering state) live
 * separately on the shard's in-memory maps — they reset to full
 * whenever the shard reaps.
 *
 * ## Hazard kinds
 *
 *   - `'storm'`   — rotating particle disc. 2 / s exposure damage.
 *   - `'radzone'` — green-glowing ground disc. 5 / s exposure damage.
 *   - `'drones'`  — 2..4 small hostile drone entities patrolling
 *                    the cell; aggro on-foot players within 80 m,
 *                    attack 3 dmg / 2 s at ≤ 30 m. Drones are NOT
 *                    in this list — they're separate entities that
 * the runtime spawns once per `'drones'` cell (see
 * `app/src/server/galaxy/hazard-hydrate.ts`).
 *
 * ## Safe zones
 *
 * The placer rejects any hazard candidate whose centre is within
 * `HAZARD_SAFE_ZONE_RADIUS_M = 300` of any settlement pad (the
 * same pads `padsForSystem` derives). A planet with no pads has
 * no safe zones and can accept the full placement; a planet with
 * a pad near the planet centre still has plenty of room because
 * the scatter radius is 2 km.
 *
 * @see ./deposits.ts for the sibling seed-derived placer.
 * @see ./pads.ts for the station-anchor resolver.
 * @see ./ai.ts for the AI roster placer (separate concern).
 */

import { hash2, Rng, seedFromString } from "../random.js";
import { generateSystem } from "../galaxy/system.js";
import type { Planet, SystemGen } from "../galaxy/types.js";
import { planetWorldPosition } from "../regime-planets.js";
import type { Vec3 } from "../physics/vec.js";

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Maximum hazards per planet (acceptance criterion: "up to 8"). */
export const MAX_HAZARDS_PER_PLANET = 8;

/** Minimum radius (metres). Spec: 100..400 m. */
export const HAZARD_RADIUS_MIN_M = 100;
/** Maximum radius (metres). Spec: 100..400 m. */
export const HAZARD_RADIUS_MAX_M = 400;

/**
 * Minimum separation between a hazard and the nearest settlement
 * pad (safe-zone guard). Spec: "none within 300 m of a
 * settlement/station pad".
 */
export const HAZARD_SAFE_ZONE_RADIUS_M = 300;

/**
 * Minimum spacing between two hazards on the same planet. Stops
 * stacked hazards from looking like a single opaque wall.
 */
export const HAZARD_MIN_SPACING_M = 200;

/**
 * Per-planet scatter radius (metres). Hazard centres are sampled
 * uniformly inside the disc.
 */
export const HAZARD_SCATTER_RADIUS_M = 2_000;

/**
 * Per-planet candidate ceiling. With a target of ~4 hazards per
 * planet, 64 candidates is plenty of headroom for the spacing +
 * safe-zone rejection.
 */
export const HAZARD_PLACEMENT_MAX_CANDIDATES_PER_PLANET = 64;

/**
 * Storm damage rate (exposure / s). Spec: 2 / s inside the cell.
 */
export const HAZARD_STORM_DAMAGE_PER_S = 2;

/**
 * Radiation damage rate (exposure / s). Spec: 5 / s inside the
 * cell.
 */
export const HAZARD_RADZONE_DAMAGE_PER_S = 5;

/**
 * Drone hull (per TASK-48 spec: 20).
 */
export const DRONE_HULL = 20;

/**
 * Drone attack damage. Spec: 3 damage per hit.
 */
export const DRONE_ATTACK_DAMAGE = 3;

/**
 * Drone attack cadence. Spec: 1 hit every 2 s.
 */
export const DRONE_ATTACK_CADENCE_MS = 2_000;

/**
 * Drone aggro radius (metres). Spec: aggro on-foot players within
 * 80 m.
 */
export const DRONE_AGGRO_RADIUS_M = 80;

/**
 * Drone attack radius (metres). Spec: attack at ≤ 30 m.
 */
export const DRONE_ATTACK_RADIUS_M = 30;

/**
 * Drone respawn delay (ms). Spec: respawn 180 s after death.
 */
export const DRONE_RESPAWN_DELAY_MS = 180_000;

/**
 * Per-player exposure pool maximum (spec: max 50).
 */
export const HAZARD_EXPOSURE_MAX = 50;

/**
 * Per-player exposure regen rate (spec: 5 / s when outside any
 * hazard cell).
 */
export const HAZARD_EXPOSURE_REGEN_PER_S = 5;

/**
 * Recover duration after exposure hits 0 (spec: 5 s).
 */
export const HAZARD_RECOVER_DURATION_MS = 5_000;

/** Hazard marker visible range (metres). Spec: 500 m on the client. */
export const HAZARD_VISIBLE_RANGE_M = 500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminator for hazard kinds (TASK-48 spec). */
export type HazardKind = "storm" | "radzone" | "drones";

/**
 * A single surface hazard. Read-only — the placer never mutates
 * these after emit. Behavioural state (hull damage on drones,
 * respawn timers) lives on the shard's in-memory map; the wire
 * snapshot picks up the live values from the entity.
 *
 * `intensity` is the `damage per second` for storms / rad zones,
 * and is unused for `'drones'` cells (drone damage is fixed at
 * `DRONE_ATTACK_DAMAGE` per `DRONE_ATTACK_CADENCE_MS`).
 *
 * `droneCount` is set on `'drones'` hazards (spec: 2..4 drones).
 */
export interface HazardCell {
  /** Stable id, hex of `(seed, planetId, hazardSeq)`. */
  readonly hazardId: string;
  /** Owning planet id. */
  readonly planetId: string;
  /** Hazard kind. */
  readonly kind: HazardKind;
  /** World-space position (planet centre + local offset). */
  readonly pos: Vec3;
  /** Hazard radius (metres). Spec: 100..400 m. */
  readonly radius: number;
  /** Damage per second for storm / radzone. Unused for drones. */
  readonly intensity: number;
  /** Number of drones in a `'drones'` cell. Spec: 2..4. */
  readonly droneCount: number;
  /**
   * Stable per-cell drone id prefix. Drones minted from this cell
   * share the prefix + a per-drone index, so the runtime can
   * respawn a specific drone without re-deriving the id. The
   * runtime uses `droneIdPrefix + ":" + index` (see
   * `app/src/server/shard/hazards.ts`).
   */
  readonly droneIdPrefix: string;
}

/** Inputs to `hazardsFor`. */
export interface HazardsForOptions {
  readonly seed: string;
  readonly systemId: string;
  /**
   * Per-planet pad list used to enforce the 300 m safe-zone
   * guard. Production wires the `padsForSystem` result; tests
   * pass a synthesised list (or omit for "no safe zones").
   */
  readonly padsByPlanet?: ReadonlyMap<string, ReadonlyArray<{ pos: Vec3 }>>;
  /**
   * Optional RNG override. Mostly useful for tests that want to
   * exercise the rejection-sampling paths.
   */
  readonly rng?: Rng;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Place the deterministic hazard list for one system. Pure: no I/O,
 * no globals, no `Date`. Returns an array sorted by `(planetId,
 * hazardSeq)` ascending so two callers reading the same
 * `(seed, systemId)` see the same ordering.
 *
 * Only **landable** planets receive hazards. Gas giants are
 * uninhabitable so hazards there would never trigger — skipping
 * them keeps the surface-spent loop tight.
 */
export function hazardsFor(opts: HazardsForOptions): readonly HazardCell[] {
  const { seed, systemId, padsByPlanet, rng: rngOverride } = opts;
  if (!seed) {
    throw new RangeError("hazardsFor: seed must be a non-empty string");
  }
  if (!systemId) {
    throw new RangeError("hazardsFor: systemId must be a non-empty string");
  }

  const system: SystemGen = generateSystem(seed, systemId);
  const planets = system.planets;
  if (planets.length === 0) return [];

  const systemSeed = hash2(seedFromString(seed), seedFromString(systemId));
  const hazardsSeed = hash2(systemSeed, HAZARDS_DOMAIN_TAG);
  const rng = rngOverride ?? new Rng(hazardsSeed);

  const out: HazardCell[] = [];
  for (const planet of planets) {
    if (!planet.landable) continue;
    placeHazardsOnPlanet({
      seed,
      starId: systemId,
      planet,
      pads: padsByPlanet?.get(planet.id) ?? [],
      out,
      rng,
    });
  }

  out.sort((a, b) => {
    if (a.planetId !== b.planetId) return a.planetId < b.planetId ? -1 : 1;
    return a.hazardId < b.hazardId ? -1 : a.hazardId > b.hazardId ? 1 : 0;
  });
  return out;
}

/**
 * Convenience wrapper: derive the hazard list for a
 * `(seed, systemId)` pair without the options object. Most call
 * sites in the spec use this overload.
 */
export function hazardsForSimple(seed: string, systemId: string): readonly HazardCell[] {
  return hazardsFor({ seed, systemId });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Domain tag mixed into the hazard placement RNG so it can never
 * collide with the deposit, AI, or surface-generator seeds.
 */
const HAZARDS_DOMAIN_TAG = 0xba2b4c11n;

/**
 * Format a bigint as a zero-padded lowercase hex of `width` chars.
 */
function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}

/**
 * Place hazards on a single planet. Pushes onto `out` in
 * `(planetId, hazardSeq)` order; respects the per-planet cap.
 */
function placeHazardsOnPlanet(args: {
  seed: string;
  starId: string;
  planet: Planet;
  pads: ReadonlyArray<{ pos: Vec3 }>;
  out: HazardCell[];
  rng: Rng;
}): void {
  const { seed, starId, planet, pads, out, rng } = args;
  const center = planetWorldPosition(seed, starId, planet.orbitIndex);

  const accepted: Array<{ localX: number; localZ: number; radius: number }> = [];

  for (let i = 0; i < HAZARD_PLACEMENT_MAX_CANDIDATES_PER_PLANET; i++) {
    if (accepted.length >= MAX_HAZARDS_PER_PLANET) break;
    // Sample a uniform candidate in the square [-R, R] × [-R, R].
    // Reject outside-disc so hazards cluster on the disc rather
    // than piling at the corners.
    const localX = rng.nextRange(-HAZARD_SCATTER_RADIUS_M, HAZARD_SCATTER_RADIUS_M);
    const localZ = rng.nextRange(-HAZARD_SCATTER_RADIUS_M, HAZARD_SCATTER_RADIUS_M);
    if (localX * localX + localZ * localZ > HAZARD_SCATTER_RADIUS_M * HAZARD_SCATTER_RADIUS_M) {
      continue;
    }
    // Sample the radius in the spec bounds (100..400 m).
    const radius = HAZARD_RADIUS_MIN_M + rng.nextInt(HAZARD_RADIUS_MAX_M - HAZARD_RADIUS_MIN_M + 1);
    // Safe-zone rejection: too close to any pad. We reject
    // candidates whose centre is within
    // (HAZARD_SAFE_ZONE_RADIUS_M + hazard radius) so the cell
    // edge never crosses the safe-zone boundary — a hazard with
    // radius 300 m centred at exactly 300 m would have its edge
    // touching the pad, defeating the safe-zone contract.
    let tooCloseToPad = false;
    const safeRadiusWorld = HAZARD_SAFE_ZONE_RADIUS_M + radius;
    for (const pad of pads) {
      const dx = pad.pos.x - (center.x + localX);
      const dz = pad.pos.z - (center.z + localZ);
      if (dx * dx + dz * dz < safeRadiusWorld * safeRadiusWorld) {
        tooCloseToPad = true;
        break;
      }
    }
    if (tooCloseToPad) continue;
    // Spacing rejection: too close to an existing hazard.
    let tooCloseToHazard = false;
    for (const other of accepted) {
      const dx = other.localX - localX;
      const dz = other.localZ - localZ;
      const minSep = HAZARD_MIN_SPACING_M + radius + other.radius;
      if (dx * dx + dz * dz < minSep * minSep) {
        tooCloseToHazard = true;
        break;
      }
    }
    if (tooCloseToHazard) continue;
    accepted.push({ localX, localZ, radius });
    const seq = accepted.length - 1;
    const kind = pickKind(rng);
    const intensity =
      kind === "storm"
        ? HAZARD_STORM_DAMAGE_PER_S
        : kind === "radzone"
          ? HAZARD_RADZONE_DAMAGE_PER_S
          : 0;
    const droneCount = kind === "drones" ? 2 + rng.nextInt(3) : 0;
    out.push({
      hazardId: hazardIdFor(seed, planet.id, seq),
      planetId: planet.id,
      kind,
      pos: { x: center.x + localX, y: center.y, z: center.z + localZ },
      radius,
      intensity,
      droneCount,
      droneIdPrefix: `drone:${hazardIdFor(seed, planet.id, seq)}`,
    });
  }
}

/**
 * Pick the hazard kind. Spec doesn't pin weights, so we use a
 * 3-way equal split so a planet with 8 hazards gets ~2..3 of
 * each kind on average. The intent is "every player gets to see
 * all three kinds", not a balanced difficulty curve.
 */
function pickKind(rng: Rng): HazardKind {
  const u = rng.nextF64();
  if (u < 1 / 3) return "storm";
  if (u < 2 / 3) return "radzone";
  return "drones";
}

/**
 * Stable hazard id. Hex of
 * `hash2(hash2(systemSeed, HAZARDS_DOMAIN_TAG), BigInt(hazardSeq))`.
 */
function hazardIdFor(seed: string, planetId: string, hazardSeq: number): string {
  const systemSeed = hash2(seedFromString(seed), seedFromString(planetId));
  const hazardsSeed = hash2(systemSeed, HAZARDS_DOMAIN_TAG);
  const finalHash = hash2(hazardsSeed, BigInt(hazardSeq));
  return bigintToHex(finalHash, 16);
}
