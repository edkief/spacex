/**
 * Resource deposit placement — TASK-37.
 *
 * Every system carries up to 120 surface resource deposits. The
 * placement is **fully seed-derived**:
 *
 *   - `depositsFor(seed, systemId)` returns the same list for any two
 *     callers with the same `(seed, systemId)` inputs.
 *   - Each deposit's position, resource id, and amount are derived
 *     from a seeded RNG keyed by `(systemSeed, planetId, "deposits")`.
 *   - Constraints (no deposits in atmosphere, no deposits below
 *     terrain, ≥ 200 m spacing) are enforced by rejection sampling
 *     inside the placement pass.
 *
 * ## Determinism contract
 *
 * The deposit list is purely a function of:
 *
 *   - the galaxy seed (`seed`)
 *   - the parent star id (`systemId`)
 *
 * Server and client both call this function with the same inputs and
 * see the same output. The persisted `deposits` table only stores
 * mutable deltas (`remaining`, `discovered`) — the position /
 * resourceId / amount are recomputed from the seed on every read.
 * This keeps the DB tiny and makes the seed the single source of
 * truth (PRD §6).
 *
 * ## Where deposits go
 *
 * Deposits are placed on **landable** planets only (gas giants are
 * never landable). Per-planet placement uses a Poisson-disc-ish
 * scatter: a fixed number of candidates per planet, each rejected
 * if it's within 200 m of an existing deposit, on a slope > 30°,
 * or fails any other constraint. The per-system cap is 120 deposits;
 * once we hit it the loop exits early.
 *
 * ## Heights
 *
 * Each deposit's `y` is computed from a per-planet `heightAt` callback
 * so the deposit sits on the terrain surface. The callback can be
 * flat (`() => 0`) for tests that don't care about the y-axis; the
 * server wires in the real surface chunk heightmap.
 *
 * @see ./resources.ts for the resource catalog (weights, prices).
 * @see ../galaxy/surface.ts for the heightmap generator.
 * @see ../galaxy/regime-planets.ts for `planetWorldPosition`.
 */

import { hash2, Rng, seedFromString } from "../random.js";
import { generateSystem } from "../galaxy/system.js";
import type { Planet, SystemGen } from "../galaxy/types.js";
import { planetWorldPosition } from "../regime-planets.js";
import { pickResource, type ResourceId } from "../resources.js";

// ---------------------------------------------------------------------------
// Tunable constants (exported so the test suite + future tuning tasks
// can read them without re-deriving the math).
// ---------------------------------------------------------------------------

/** Hard cap on deposits per system (acceptance criterion). */
export const MAX_DEPOSITS_PER_SYSTEM = 120;

/** Initial amount range (inclusive bounds). */
export const DEPOSIT_MIN_AMOUNT = 10;
export const DEPOSIT_MAX_AMOUNT = 50;

/** Minimum spacing between two deposits on the same planet (metres). */
export const DEPOSIT_MIN_SPACING_M = 200;

/** Maximum terrain slope (degrees). Deposits on steeper slopes are rejected. */
export const DEPOSIT_MAX_SLOPE_DEG = 30;

/**
 * Per-planet candidate ceiling. With a target of ~30 deposits per
 * planet (120 / 4 landable planets on average), 200 candidates is
 * plenty of headroom for the spacing + slope rejection.
 */
export const DEPOSIT_PLACEMENT_MAX_CANDIDATES_PER_PLANET = 200;

/** Scatter radius (metres) around the planet's centre. */
export const DEPOSIT_SCATTER_RADIUS_M = 2_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single deposit's seed-derived state. Positions are in world space
 * (planet centre + heightAt offset). `amount` is the initial stock;
 * mining decrements it via the persistence layer (TASK-37 step 2).
 *
 * `discovered` flips to `true` server-side the first time a player
 * comes within `DISCOVERY_RANGE_M = 50` of the deposit. The flag is
 * kept on the shape so future tasks can render the marker without a
 * schema migration.
 */
export interface Deposit {
  /** Stable id, hex of `(systemSeed, planetId, depositSeq)`. */
  readonly depositId: string;
  /** Owning planet id. */
  readonly planetId: string;
  /** World-space position. `y` matches the terrain altitude at `(pos.x, pos.z)`. */
  readonly pos: { x: number; y: number; z: number };
  /** Resource type carried by this deposit (catalog id). */
  readonly resourceId: ResourceId;
  /** Initial stock (units). Decremented atomically by the mine transaction (TASK-38). */
  readonly amount: number;
  /**
   * `true` once any player has come within `DISCOVERY_RANGE_M = 50`
   * of the deposit. Mutated server-side only; the client receives
   * the flag in the wire snapshot.
   */
  readonly discovered: boolean;
}

/** Discovery radius (metres). Acceptance criterion. */
export const DISCOVERY_RANGE_M = 50;

/** Per-planet heightAt callback contract — `(localX, localZ) => metres`. */
export type DepositHeightAtFn = (localX: number, localZ: number) => number;

/** Inputs to `depositsFor`. */
export interface DepositsForOptions {
  /** Galaxy seed. Same string the rest of the shared galaxy uses. */
  readonly seed: string;
  /** Star id (== system id for v1). */
  readonly systemId: string;
  /**
   * Optional per-planet `heightAt` callback. When supplied, deposit
   * `y` values come from `planetCenter.y + heightAt(localX, localZ)`.
   * When omitted, deposits sit at `planetCenter.y` (a flat world).
   */
  readonly heightAtFor?: (planetId: string) => DepositHeightAtFn | undefined;
  /**
   * Optional override for the RNG (mostly useful for tests). When
   * omitted the placement uses an internally-derived RNG so the
   * `(seed, systemId)` pair alone produces a deterministic list.
   */
  readonly rng?: Rng;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Place the deterministic deposit list for one system. Pure: no I/O,
 * no globals, no `Date`. Returns an array sorted by `(planetId,
 * depositSeq)` ascending so two callers reading the same `(seed,
 * systemId)` see the same ordering.
 */
export function depositsFor(opts: DepositsForOptions): readonly Deposit[] {
  const { seed, systemId, heightAtFor, rng: rngOverride } = opts;
  if (!seed) {
    throw new RangeError("depositsFor: seed must be a non-empty string");
  }
  if (!systemId) {
    throw new RangeError("depositsFor: systemId must be a non-empty string");
  }

  // System id === star id for v1 (TASK-3 + TASK-4 keep them equal).
  // `generateSystem(seed, starId)` reconstructs the system from the
  // id and gives us back the deterministic planet list.
  const system: SystemGen = generateSystem(seed, systemId);
  const planets = system.planets;
  if (planets.length === 0) return [];

  // Build the deposit RNG. We derive the system seed from
  // `hash2(seedFromString(seed), seedFromString(systemId))` — same
  // chain the surface generator uses — so two callers that produce
  // the same planet list get the same deposit RNG state.
  const systemSeed = hash2(seedFromString(seed), seedFromString(systemId));
  const depositsSeed = hash2(systemSeed, DEPOSIT_DOMAIN_TAG);
  const rng = rngOverride ?? new Rng(depositsSeed);

  const deposits: Deposit[] = [];
  for (const planet of planets) {
    if (deposits.length >= MAX_DEPOSITS_PER_SYSTEM) break;
    if (!planet.landable) continue;
    placeDepositsOnPlanet({
      seed,
      starId: systemId,
      planet,
      deposits,
      heightAt: heightAtFor?.(planet.id),
      rng,
    });
  }

  // Sort for stable ordering: (planetId, depositSeq) ascending. The
  // placement loop already emits in that order but sorting defends
  // against future tweaks.
  deposits.sort((a, b) => {
    if (a.planetId !== b.planetId) return a.planetId < b.planetId ? -1 : 1;
    return a.depositId < b.depositId ? -1 : a.depositId > b.depositId ? 1 : 0;
  });

  return deposits;
}

/**
 * Convenience wrapper: derive the deposit list for a `(seed, systemId)`
 * pair without the options object. Most call sites in the spec use
 * this overload.
 */
export function depositsForSimple(seed: string, systemId: string): readonly Deposit[] {
  return depositsFor({ seed, systemId });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Domain tag mixed into the deposit placement RNG so it can never
 * collide with the planet, system, or surface-generator seeds.
 */
const DEPOSIT_DOMAIN_TAG = 0xdec0ed01n;

/** Hex-encode a bigint to a 16-char lowercase string. */
function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}

/**
 * Place deposits on a single planet. Pushes onto `out` in
 * `(planetId, depositSeq)` order; respects the per-system cap.
 */
function placeDepositsOnPlanet(args: {
  seed: string;
  starId: string;
  planet: Planet;
  deposits: Deposit[];
  heightAt: DepositHeightAtFn | undefined;
  rng: Rng;
}): void {
  const { seed, starId, planet, deposits, heightAt, rng } = args;

  // The deterministic planet world position from the regime-planets
  // resolver (TASK-25). Both server and client derive this from
  // `(seed, starId, orbitIndex)` so the placement is identical on
  // both sides.
  const centre = planetWorldPosition(seed, starId, planet.orbitIndex);

  // Track accepted candidates for the spacing constraint. Keys are
  // 2-D points; we walk the array on each candidate (the deposit
  // count is bounded, so the O(n²) check is fine).
  const accepted: Array<{ localX: number; localZ: number }> = [];

  for (let i = 0; i < DEPOSIT_PLACEMENT_MAX_CANDIDATES_PER_PLANET; i++) {
    if (deposits.length >= MAX_DEPOSITS_PER_SYSTEM) return;
    // Sample a uniform candidate in the square [-R, R] × [-R, R].
    // We reject outside-disc candidates so deposits cluster on the
    // disc rather than piling up at the corners.
    const localX = rng.nextRange(-DEPOSIT_SCATTER_RADIUS_M, DEPOSIT_SCATTER_RADIUS_M);
    const localZ = rng.nextRange(-DEPOSIT_SCATTER_RADIUS_M, DEPOSIT_SCATTER_RADIUS_M);
    if (localX * localX + localZ * localZ > DEPOSIT_SCATTER_RADIUS_M * DEPOSIT_SCATTER_RADIUS_M) {
      continue;
    }
    // Reject too-close to any prior deposit on the same planet.
    let tooClose = false;
    for (let j = 0; j < accepted.length; j++) {
      const other = accepted[j] as { localX: number; localZ: number };
      const dx = other.localX - localX;
      const dz = other.localZ - localZ;
      if (dx * dx + dz * dz < DEPOSIT_MIN_SPACING_M * DEPOSIT_MIN_SPACING_M) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    // Reject steep slopes. The slope is the gradient magnitude of
    // heightAt at the candidate point — sampled via central
    // differences (cheap; we don't need a real derivative).
    const heightFn: DepositHeightAtFn = heightAt ?? (() => 0);
    const dh = 1;
    const hC = heightFn(localX, localZ);
    const hX = heightFn(localX + dh, localZ);
    const hZ = heightFn(localX, localZ + dh);
    const slope = Math.atan2(Math.hypot(hX - hC, hZ - hC), dh);
    if (Number.isNaN(slope)) continue;
    if ((slope * 180) / Math.PI > DEPOSIT_MAX_SLOPE_DEG) continue;
    // Accept the candidate. `y` is planet centre + terrain altitude.
    accepted.push({ localX, localZ });
    const amount = DEPOSIT_MIN_AMOUNT + rng.nextInt(DEPOSIT_MAX_AMOUNT - DEPOSIT_MIN_AMOUNT + 1);
    const resourceId = pickResource(rng);
    const depositSeq = accepted.length - 1;
    const depositId = depositIdFor(seed, planet.id, depositSeq);
    deposits.push({
      depositId,
      planetId: planet.id,
      pos: {
        x: centre.x + localX,
        y: centre.y + hC,
        z: centre.z + localZ,
      },
      resourceId,
      amount,
      discovered: false,
    });
  }
}

/**
 * Stable deposit id. Hex of `hash2(hash2(systemSeed, DEPOSIT_DOMAIN_TAG), BigInt(depositSeq))`.
 * Independent per-planet (the seq is local to the planet's scatter pass).
 */
function depositIdFor(seed: string, planetId: string, depositSeq: number): string {
  const systemSeed = hash2(seedFromString(seed), seedFromString(planetId));
  const depositsSeed = hash2(systemSeed, DEPOSIT_DOMAIN_TAG);
  const finalHash = hash2(depositsSeed, BigInt(depositSeq));
  return bigintToHex(finalHash, 16);
}
