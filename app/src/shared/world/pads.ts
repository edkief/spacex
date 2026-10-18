/**
 * Pad registry — TASK-29.
 *
 * Every station and planetary settlement has exactly one landing pad
 * (TASK-4 + TASK-5): the player can hover and park on it, the pad is
 * a server-authoritative state, and the pad is the anchor for the
 * on-foot transition (TASK-31).
 *
 * This module is the **single source of truth** for the pad registry
 * shared by server (pad detection in the sim tick) and client (ring
 * markers, docked HUD indicator). Pads are seeded entities:
 *
 *   - Each landable planet has a primary pad placed at the centre of
 *     the flattest `PAD_BLOCK_SIZE_CELLS × PAD_BLOCK_SIZE_CELLS` block
 *     in chunk `(0, 0)`. The chunk-(0,0) landable override from
 *     `placeLandingPads` (TASK-5) guarantees exactly one pad per
 *     landable planet.
 *   - Each pad carries a deterministic id (the hex of
 *     `hash2(chunkSeed, PAD_DOMAIN_TAG)`), a world-space position
 *     derived from the planet's deterministic centre + the
 *     chunk-local pad anchor, and a 20 m detection radius.
 *
 * The module exposes:
 *
 *   - `padForPlanet(args)` — derive the single primary pad for one
 *     planet (chunk 0,0). Deterministic; the cost is one
 *     `generateSurfaceChunk` call (cached by callers).
 *   - `padsForSystem(args)` — derive every primary pad in a system
 *     (one per landable planet). Pure: callers should cache the
 *     result keyed by `systemId`.
 *   - `nearestPad(args)` — pick the closest pad within `radius` of a
 *     world position, with explicit `padEnterRadius` /
 *     `padExitRadius` hysteresis. Used by the sim tick to evaluate
 *     dock conditions (TASK-29 step 2) and by the client VTOL-assist
 *     HUD to surface the nearest target.
 *
 * ## Determinism contract
 *
 *   - `padForPlanet({seed, planet})` returns the SAME `{padId, pos,
 *     radius}` for any two callers with the same `(seed, planet.id)`.
 *     The chain is: `chunkSeedDerivation(seed, planet.id, 0, 0)` →
 *     `placeLandingPads` → `findFlatSpot` → `{x, z}` chunk-local →
 *     `(planetCenter.x + x, planetCenter.y + heightAt(x, z) +
 *     padHeight, planetCenter.z + z)` world position.
 *   - The `planetCenter` resolver is `planetWorldPosition(seed,
 *     starId, planet.orbitIndex)` (TASK-25). The `heightAt` closure
 *     comes from the generated heightmap of chunk (0, 0).
 *
 * @see ./types.ts for the wire-level `LandingPad` shape (chunk-local).
 * @see ../../shared/galaxy/surface.ts for the chunk generator.
 * @see ../../shared/galaxy/surface-placement.ts for `placeLandingPads`.
 * @see ../../shared/regime-planets.ts for `planetWorldPosition`.
 * @see ../../server/shard/sim.ts for the tick-side pad detection.
 */

import { generateSurfaceChunk } from "../galaxy/surface.js";
import { planetWorldPosition } from "../regime-planets.js";
import type { Planet } from "../galaxy/types.js";
import type { Vec3 } from "../physics/vec.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A landing pad in world space. Same id as the deterministic
 * `LandingPad.id` from `surface-placement.ts` (TASK-5), but with a
 * world-space position (planet centre + chunk-local offset) so the
 * sim tick can resolve it against `entity.pos` without a separate
 * planet lookup.
 *
 * `normal` is the up vector at the pad site (always `(0, 1, 0)` for
 * v1 — the heightmap is locally flat around the flattest spot, so
 * the surface normal is essentially world-up; the field is here for
 * future tasks that may tilt the pad).
 *
 * `kind` tags the pad as a station/settlement anchor vs. an
 * ad-hoc outpost. v1 only emits `'settlement'` (every landable
 * planet has exactly one primary pad) — `kind` exists so future
 * tasks can add separate station entities without breaking
 * downstream consumers.
 */
export interface SystemPad {
  /** Deterministic pad id (matches `LandingPad.id` from TASK-5). */
  readonly padId: string;
  /** Owning planet id. */
  readonly planetId: string;
  /** Pad kind tag (v1 only emits 'settlement'). */
  readonly kind: "station" | "settlement";
  /** World-space position of the pad centre. */
  readonly pos: Vec3;
  /** Surface normal at the pad (v1: world up). */
  readonly normal: Vec3;
  /** Pad detection radius in metres (entry hysteresis). */
  readonly radius: number;
  /** Pad exit hysteresis radius in metres (≥ radius). */
  readonly exitRadius: number;
}

/** Default pad detection radius — spec calls for 20 m. */
export const PAD_RADIUS_M = 20;

/** Pad exit hysteresis — spec calls for 25 m. */
export const PAD_EXIT_RADIUS_M = 25;

// ---------------------------------------------------------------------------
// Per-planet pad derivation
// ---------------------------------------------------------------------------

/**
 * Derive the primary pad for a single planet.
 *
 * Inputs:
 *   - `seed` — the galaxy seed.
 *   - `starId` — the parent star id (drives `planetWorldPosition`).
 *   - `planet` — the `Planet` record from `generateSystem`.
 *
 * Returns `null` for non-landable planets (gas giants and the rare
 * non-gas planet that rolls outside `NON_GAS_LANDABLE_PROBABILITY`).
 * The server caches the per-planet result by `planet.id` so a
 * `padsForSystem` call is amortised.
 */
export function padForPlanet(args: {
  seed: string;
  starId: string;
  planet: Planet;
}): SystemPad | null {
  if (!args.planet.landable) return null;
  const chunk = generateSurfaceChunk(args.seed, args.planet, 0, 0);
  const landingPad = chunk.landingPads[0];
  if (!landingPad) {
    // Defensive — `placeLandingPads` is supposed to guarantee a pad
    // in chunk (0, 0) of a landable planet. If a future refactor
    // breaks the contract, surface it loudly so the test suite can
    // catch it rather than silently returning a "no pads" system.
    throw new Error(
      `padForPlanet: chunk (0, 0) of landable planet ${args.planet.id} returned no pad`,
    );
  }
  const center = planetWorldPosition(args.seed, args.starId, args.planet.orbitIndex);
  // Chunk-local metres: 1 cell = 1 m. Chunk (0, 0) is centred on
  // the planet, so chunk-local cell (X, Z) sits at world-local
  // `(X - 32, Z - 32)` relative to the planet centre. The pad's
  // altitude in v1 is the planet's surface (`planetCenter.y +
  // planet.radius`) — the heightmap wiring lives in TASK-26, and
  // until then the pad-detection math is flat.
  const localX = landingPad.x - 32;
  const localZ = landingPad.z - 32;
  const worldPos: Vec3 = {
    x: center.x + localX,
    y: center.y + args.planet.radiusKm * 1000,
    z: center.z + localZ,
  };
  return {
    padId: landingPad.id,
    planetId: args.planet.id,
    kind: "settlement",
    pos: worldPos,
    normal: { x: 0, y: 1, z: 0 },
    radius: PAD_RADIUS_M,
    exitRadius: PAD_EXIT_RADIUS_M,
  };
}

// ---------------------------------------------------------------------------
// Per-system pad registry
// ---------------------------------------------------------------------------

/**
 * Derive every primary pad in a system — one per landable planet,
 * in orbit order. Pure: callers should cache by `systemId`.
 */
export function padsForSystem(args: {
  seed: string;
  starId: string;
  planets: readonly Planet[];
}): SystemPad[] {
  const out: SystemPad[] = [];
  for (const planet of args.planets) {
    const pad = padForPlanet({ seed: args.seed, starId: args.starId, planet });
    if (pad !== null) out.push(pad);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Pick the closest pad to a world position, subject to a per-call
 * radius. When `alreadyDockedOn !== null` the lookup uses
 * `pad.exitRadius` for that specific pad (hysteresis: harder to
 * take off than to dock) and `pad.radius` for every other pad.
 *
 * Returns `null` if no pad is within range.
 */
export function nearestPad(args: {
  pos: Vec3;
  pads: readonly SystemPad[];
  radiusOverride?: number;
  alreadyDockedOn?: string | null;
}): SystemPad | null {
  const override = args.radiusOverride ?? Infinity;
  let best: SystemPad | null = null;
  let bestDistSq = Infinity;
  for (const pad of args.pads) {
    const isCurrent = pad.padId === args.alreadyDockedOn;
    const r = isCurrent ? pad.exitRadius : pad.radius;
    if (r > override) continue;
    const dx = args.pos.x - pad.pos.x;
    const dy = args.pos.y - pad.pos.y;
    const dz = args.pos.z - pad.pos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= r * r && distSq < bestDistSq) {
      bestDistSq = distSq;
      best = pad;
    }
  }
  return best;
}

/**
 * Filter pads to those within `radius` metres of a world position.
 * Convenience for the client-side marker renderer (TASK-29 step 3):
 * we only want to render rings within 500 m so the scene doesn't
 * get cluttered with pads from distant planets.
 */
export function padsWithinRadius(args: {
  pos: Vec3;
  pads: readonly SystemPad[];
  radius: number;
}): SystemPad[] {
  const out: SystemPad[] = [];
  const r2 = args.radius * args.radius;
  for (const pad of args.pads) {
    const dx = args.pos.x - pad.pos.x;
    const dy = args.pos.y - pad.pos.y;
    const dz = args.pos.z - pad.pos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= r2) out.push(pad);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-exports — keep the public surface in one place.
// ---------------------------------------------------------------------------

export type { Planet };
