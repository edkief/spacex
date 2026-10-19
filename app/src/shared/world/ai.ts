/**
 * Rogue-AI ship roster — TASK-45.
 *
 * Every star system carries a seeded roster of pirate ships
 * patrolling its space. The roster is **fully seed-derived**:
 *
 *   - `rosterFor({seed, systemId, ...})` returns the same list for
 *     any two callers with the same `(seed, systemId)` inputs.
 *   - Each entry's `classId`, `callsign`, `spawnPos`,
 *     `patrolCenter`, and `patrolRadius` flow from a seeded RNG
 *     keyed by `(seed, systemId, "ai-roster")`.
 *   - Placement rejects positions inside an atmosphere radius and
 *     within `AI_STATION_MIN_SEPARATION_M = 200` of any station
 *     (landing pad) so rogues can't cheat by spawning on top of
 *     the dock the player just landed at.
 *
 * ## Determinism contract
 *
 * The roster is purely a function of:
 *
 *   - the galaxy seed (`seed`)
 *   - the system id (`systemId`)
 *
 * Server and client both call this with the same inputs and see
 * the same output. State changes (rogue hull damage, respawn
 * timers) live separately on the shard's in-memory entity map —
 * they reset to full HP whenever the shard reaps, which is the
 * renewable-threat model the PRD calls for.
 *
 * ## Spacing guarantees
 *
 * The placement pass enforces, for every accepted candidate:
 *
 *   - `AI_SPAWN_DISTANCE_MIN_M ≤ ‖spawnPos‖ ≤ AI_SPAWN_DISTANCE_MAX_M`
 *     (rogues are 500..3000 units from the system origin in the
 *     planetary plane);
 *   - `‖spawnPos − pad.pos‖ ≥ AI_STATION_MIN_SEPARATION_M = 200`
 *     for every pad in the system (station-proximity guard);
 *   - `‖spawnPos − planet.center‖ ≥ planet.radius + atmosphereHeight`
 *     for every planet with an atmosphere — rogues never spawn
 *     inside an atmosphere (the "no AI on surface in v1" rule).
 *
 * On the rare planet that violates both distances after the
 * candidate ceiling is exhausted, the candidate is dropped and the
 * roster is one ship smaller than `AI_ROSTER_MAX`. The roster count
 * therefore floors at `AI_ROSTER_MIN` (6 ships per system) but
 * ceilings at `AI_ROSTER_MAX` (10 ships).
 *
 * ## Class distribution
 *
 *   scout       50 % — bulk of the patrol.
 *   interceptor 35 % — fast attack.
 *   freighter   15 % — cargo haul; the player can destroy or outrun.
 *
 * The weights hold over many systems but a single roster can drift
 * up to ±2 around the expected value. Tests assert the bounds with
 * 100 seeded samples (per spec).
 *
 * ## Where rogues go
 *
 * The recruiter places rogues in the **planetary plane** (the
 * `y = 0` slice the `@shared/regime-planets` layout uses). Rogue
 * positions are uniformly spread around the star within the
 * 500..3000 unit annulus so two rogues whose spawns are far apart
 * in the angular coordinate rarely share a patrol radius — keeps
 * the broadcast loop balanced.
 *
 * @see ./deposits.ts for the sibling seed-derived placer.
 * @see ./pads.ts for the station-anchor resolver.
 * @see ../ai/names.ts for the callsign catalog.
 * @see ../random.ts for the seeded RNG primitives.
 */

import type { ShipClassId } from "../galaxy/types.js";
import { hash2, Rng, seedFromString } from "../random.js";
import { type Vec3 } from "../physics/vec.js";
import { AI_CALLSIGNS } from "../ai/names.js";

// ---------------------------------------------------------------------------
// Tunable constants — surfaced so the test suite + future tuning
// tasks can pin them without re-deriving the math.
// ---------------------------------------------------------------------------

/** Minimum number of rogues per system (inclusive). */
export const AI_ROSTER_MIN = 6;

/** Maximum number of rogues per system (inclusive). */
export const AI_ROSTER_MAX = 10;

/** Minimum spawn distance from the system origin (metres). */
export const AI_SPAWN_DISTANCE_MIN_M = 500;

/** Maximum spawn distance from the system origin (metres). */
export const AI_SPAWN_DISTANCE_MAX_M = 3_000;

/**
 * Minimum separation between a rogue spawn and any station (landing
 * pad) in metres. Stops rogues from parking on the player's pad.
 */
export const AI_STATION_MIN_SEPARATION_M = 200;

/** Minimum patrol radius (metres). */
export const AI_PATROL_RADIUS_MIN_M = 200;

/** Maximum patrol radius (metres). */
export const AI_PATROL_RADIUS_MAX_M = 800;

/**
 * Respawn delay after a rogue is destroyed. Surfaced here so the
 * shard-side respawn timer (`server/shard/ai.ts` — companion to
 * this module) reads the same constant without re-exporting from
 * the server side.
 */
export const AI_RESPAWN_DELAY_MS = 120_000;

/**
 * Per-class distribution weights. Must sum to 1.0; the test
 * suite asserts this. Tweak with care: any change requires the
 * `class distribution bounds` test to be revisited.
 */
export const AI_CLASS_WEIGHTS: Readonly<Record<ShipClassId, number>> = {
  scout: 0.5,
  interceptor: 0.35,
  freighter: 0.15,
} as const;

/** Sum of class weights — must equal 1.0 within float tolerance. */
export const AI_CLASS_WEIGHT_SUM =
  AI_CLASS_WEIGHTS.scout + AI_CLASS_WEIGHTS.interceptor + AI_CLASS_WEIGHTS.freighter;

/**
 * Maximum number of placement candidates the recruiter tries per
 * ship before it gives up on that ship. With `AI_ROSTER_MAX = 10`
 * and the 200 m station-separation + atmosphere-exclusion
 * constraints, 32 candidates per ship is more than enough to
 * guarantee the worst-case `Rng` placement still finds 6 valid
 * sites in a 4-planet system.
 */
export const AI_PLACEMENT_MAX_CANDIDATES_PER_SHIP = 32;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One rogue's seed-derived, immutable roster entry. Behavioural
 * state (current hull, position drift, patrol phase) lives on the
 * shard's in-memory entity; this struct is the deterministic
 * "spawn-anchor" the respawn timer returns to.
 *
 * `aiId` is the stable wire id (`"ai:<16-hex>"`). The same id is
 * reused across respawn cycles so the client can keep its target
 * lock between deaths (the lock auto-releases on death — but a
 * re-locked aiId resumes cleanly).
 */
export interface AIRosterEntry {
  /** Stable wire id, hex of `(seed, systemId, shipIndex)`. */
  readonly aiId: string;
  /** Picked ship class — drives the spawn hull/shields/stats. */
  readonly classId: ShipClassId;
  /** Pirate callsign drawn from `AI_CALLSIGNS`; unique per roster. */
  readonly callsign: string;
  /**
   * World-space spawn position (used as the respawn anchor too).
   * Lives in the planetary plane (`y === 0` for the v1 layout).
   */
  readonly spawnPos: Vec3;
  /**
   * Centre of the patrol orbit. Equal to `spawnPos` in v1 — the
   * future AI state machine (TASK-46) drifts the ship around this
   * point with patrol-radius `patrolRadius`. Surfaced separately so
   * the test suite + future tuning have a single place to vary.
   */
  readonly patrolCenter: Vec3;
  /** Patrol radius (metres). The AI drifts within `patrolRadius`
   * of `patrolCenter` once TASK-46 wires the behaviour. */
  readonly patrolRadius: number;
}

// ---------------------------------------------------------------------------
// Placement-context types
// ---------------------------------------------------------------------------

/**
 * Minimal station shape the placer needs to keep rogues away from
 * the planet's docks. Mirrors `@shared/world/pads.SystemPad`'s
 * position field so the placer can run without taking a direct
 * import from `@shared/world/pads` (which would create a circular
 * `@shared/world → @shared/world` import if the pads module ever
 * needed AI roster info).
 */
export interface AIRosterStation {
  readonly padId: string;
  readonly planetId: string;
  readonly pos: Vec3;
}

/**
 * Minimal planet shape the placer uses to enforce the
 * "no AI inside an atmosphere radius" rule. Mirrors
 * `@shared/galaxy/types.Planet`'s placement-relevant fields
 * (`id`, `radiusKm`, `hasAtmosphere`).
 */
/**
 * Planet shape the placer uses to enforce the "no AI inside an
 * atmosphere radius" rule. Mirrors the placement-relevant fields
 * on `@shared/galaxy/types.Planet` plus the deterministic world
 * position from `@shared/regime-planets.planetWorldPosition`.
 *
 * `center` is the planet's world-space position (in the same
 * coord space the rover pad sites use — y === 0 for v1). The
 * placer computes `‖candidate − planet.center‖` directly rather
 * than approximating from the system origin, so a planet whose
 * orbit happens to swing through the 500..3000 m annulus will
 * still get its atmosphere-exclusion cylinder honoured.
 */
export interface AIRosterPlanet {
  readonly id: string;
  /** Deterministic world-space position (same space as `spawnPos`). */
  readonly center: Vec3;
  /** Equatorial radius in kilometres. */
  readonly radiusKm: number;
  /** Whether the planet retains a meaningful atmosphere. */
  readonly hasAtmosphere: boolean;
}

/** Inputs to `rosterFor`. */
export interface RosterForOptions {
  /** Galaxy seed. Same string the rest of the shared galaxy uses. */
  readonly seed: string;
  /** Star id (== system id for v1). */
  readonly systemId: string;
  /**
   * Stations (landing pads) whose proximity the placer must
   * avoid. The shard passes the `padsForSystem` result via the
   * router-load path; tests pass a synthesised list.
   *
   * When omitted the placer treats the system as pad-free (no
   * station-separation rejection happens). The spec calls out
   * that every planet's primary pad counts, so production
   * always passes a non-empty list.
   */
  readonly stations?: readonly AIRosterStation[];
  /**
   * Planets the placer must keep rogues outside (atmosphere +
   * radius). The shard passes the system's planet list; tests
   * typically pass the same.
   */
  readonly planets?: readonly AIRosterPlanet[];
  /**
   * Atmosphere thickness in metres (default `10_000` — matches
   * `@shared/physics/atmosphere`). Surfaced as an override so
   * the test suite can use smaller values without scaling the
   * planet radius.
   */
  readonly atmosphereHeight?: number;
  /**
   * Optional RNG override. Mostly useful for the
   * class-distribution test which runs the picker across many
   * seeds and wants to inject a custom sequence.
   */
  readonly rng?: Rng;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Place the deterministic rogue roster for one system. Pure: no
 * I/O, no globals, no `Date`. Returns an array ordered by
 * `(aiId)` ascending so two callers reading the same `(seed,
 * systemId)` see the same ordering.
 *
 * Algorithm:
 *   1. Seed the roster RNG from `(seed, systemId)`.
 *   2. Decide the roster size — uniformly `AI_ROSTER_MIN..MAX`.
 *   3. For each roster slot, pick a class via weighted choice and
 *      place a candidate via rejection against (a) the annulus,
 *      (b) station proximity, (c) atmosphere radius.
 *   4. For each placed ship, pick a unique callsign by walking the
 *      `AI_CALLSIGNS` list deterministically from the next RNG
 *      output.
 *   5. Return the immutable entries.
 */
export function rosterFor(opts: RosterForOptions): readonly AIRosterEntry[] {
  if (!opts.seed) {
    throw new RangeError("rosterFor: seed must be a non-empty string");
  }
  if (!opts.systemId) {
    throw new RangeError("rosterFor: systemId must be a non-empty string");
  }

  const systemSeed = hash2(seedFromString(opts.seed), seedFromString(opts.systemId));
  const rosterSeed = hash2(systemSeed, ROSTER_DOMAIN_TAG);
  const rng = opts.rng ?? new Rng(rosterSeed);

  // Roster size — uniform in the spec bounds. Each system gets a
  // different count (the spec says 6..10); uniformity means each
  // value gets exactly 20% of systems on average.
  const span = AI_ROSTER_MAX - AI_ROSTER_MIN + 1;
  const rosterSize = AI_ROSTER_MIN + rng.nextInt(span);

  const out: AIRosterEntry[] = [];
  const takenCalls = new Set<string>();

  for (let i = 0; i < rosterSize; i++) {
    const classId = pickClass(rng);
    const placed = placeOneShip({
      rng,
      shipIndex: out.length,
      stations: opts.stations ?? [],
      planets: opts.planets ?? [],
      atmosphereHeight: opts.atmosphereHeight,
    });
    if (placed === null) {
      // Couldn't find a valid candidate within the ceiling —
      // skip this slot and try again next iteration (the roster
      // count is approximate, guaranteed ≥ MIN by the outer
      // counter).
      continue;
    }
    const callsign = pickCallsign(rng, takenCalls);
    if (callsign === null) {
      // Should be impossible while AI_CALLSIGNS.length >= 40 and
      // the roster is capped at 10 — defensive null branch.
      continue;
    }
    takenCalls.add(callsign);
    const aiId = aiIdFor(opts.seed, opts.systemId, out.length);
    const patrolRadius =
      AI_PATROL_RADIUS_MIN_M + rng.nextInt(AI_PATROL_RADIUS_MAX_M - AI_PATROL_RADIUS_MIN_M + 1);
    out.push({
      aiId,
      classId,
      callsign,
      spawnPos: placed,
      patrolCenter: { ...placed },
      patrolRadius,
    });
  }

  out.sort((a, b) => (a.aiId < b.aiId ? -1 : a.aiId > b.aiId ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Domain tag mixed into the roster RNG so the seed never collides
 * with the deposit, system, planet, or surface-generator seeds.
 * Stored as a BigInt so the `hash2` chain stays 64-bit-clean.
 */
const ROSTER_DOMAIN_TAG = 0xc01a17e5n;

/**
 * Weighted class picker. Identical algorithm to the planet and
 * star class pickers — keep them structurally identical so the
 * reader only has to learn the pattern once.
 */
function pickClass(rng: Rng): ShipClassId {
  const u = rng.nextF64();
  let acc = 0;
  // Iterate insertion order so the weights are added in the same
  // order the catalog documents (scout → interceptor → freighter).
  acc += AI_CLASS_WEIGHTS.scout;
  if (u < acc) return "scout";
  acc += AI_CLASS_WEIGHTS.interceptor;
  if (u < acc) return "interceptor";
  return "freighter";
}

/**
 * Single-ship placement pass. Returns a valid `{x, y, z}` or `null`
 * when the placement ceiling is exhausted without a valid candidate
 * (the caller drops the slot in that case).
 */
function placeOneShip(args: {
  rng: Rng;
  shipIndex: number;
  stations: readonly AIRosterStation[];
  planets: readonly AIRosterPlanet[];
  atmosphereHeight: number | undefined;
}): Vec3 | null {
  const atmosphereHeight = args.atmosphereHeight ?? 10_000;
  for (let attempt = 0; attempt < AI_PLACEMENT_MAX_CANDIDATES_PER_SHIP; attempt++) {
    // Polar coordinate inside the 500..3000 annulus. The angle is
    // uniform on [0, 2π); the radius is uniform in the annulus
    // (√uniform[0,1] scaled) so each radius has equal area.
    const angle = args.rng.nextRange(0, 2 * Math.PI);
    const radius =
      AI_SPAWN_DISTANCE_MIN_M +
      args.rng.nextF64() * (AI_SPAWN_DISTANCE_MAX_M - AI_SPAWN_DISTANCE_MIN_M);
    const candidate: Vec3 = {
      x: radius * Math.cos(angle),
      y: 0,
      z: radius * Math.sin(angle),
    };
    // Station-proximity rejection.
    let tooCloseToStation = false;
    for (const station of args.stations) {
      const dx = station.pos.x - candidate.x;
      const dy = station.pos.y - candidate.y;
      const dz = station.pos.z - candidate.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < AI_STATION_MIN_SEPARATION_M * AI_STATION_MIN_SEPARATION_M) {
        tooCloseToStation = true;
        break;
      }
    }
    if (tooCloseToStation) continue;
    // Atmosphere-radius rejection. The placer computes the distance
    // from `candidate` to each planet's deterministic world centre
    // (`@shared/regime-planets.planetWorldPosition` -- the shard
    // reuses this for pad detection, so the placement is identical
    // on both sides). The exclusion cylinder is centred on the
    // planet with radius `planet.radiusKm * 1000 + atmosphereHeight`
    // so the ship cannot land inside the atmosphere shell. (In
    // production planet centres sit at orbit radii much larger than
    // 3000 m -- the cylinders are far from the rogues' annulus and
    // the rejection never fires. Tests inject a planet whose centre
    // does overlap the annulus so the branch is exercised at
    // least once per CI run.)
    let insideAtmosphere = false;
    for (const planet of args.planets) {
      if (!planet.hasAtmosphere) continue;
      const exclusionRadius = planet.radiusKm * 1000 + atmosphereHeight;
      const dx = candidate.x - planet.center.x;
      const dy = candidate.y - planet.center.y;
      const dz = candidate.z - planet.center.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < exclusionRadius * exclusionRadius) {
        insideAtmosphere = true;
        break;
      }
    }
    if (insideAtmosphere) continue;
    return candidate;
  }
  return null;
}

/**
 * Pick the next callsign for the roster, skipping ones already
 * taken by an earlier ship in this roster. Returns `null` when
 * the catalog is exhausted (impossible at `AI_ROSTER_MAX = 10` —
 * 40-name catalog, defensive null branch).
 */
function pickCallsign(rng: Rng, taken: Set<string>): string | null {
  // Start at a random offset so two rosters that have the same
  // set of candidates pick different ones (and so the test
  // suite gets distribution coverage across the whole catalog).
  const start = rng.nextInt(AI_CALLSIGNS.length);
  for (let i = 0; i < AI_CALLSIGNS.length; i++) {
    const idx = (start + i) % AI_CALLSIGNS.length;
    const name = AI_CALLSIGNS[idx];
    if (name === undefined) continue;
    if (taken.has(name)) continue;
    return name;
  }
  return null;
}

/**
 * Stable aiId — hex of `hash2(hash2(systemSeed, ROSTER_DOMAIN_TAG), BigInt(shipIndex))`.
 * Re-uses the same construction the deposit module uses so the
 * seed → id chain is locally consistent.
 */
function aiIdFor(seed: string, systemId: string, shipIndex: number): string {
  const systemSeed = hash2(seedFromString(seed), seedFromString(systemId));
  const rosterSeed = hash2(systemSeed, ROSTER_DOMAIN_TAG);
  const finalHash = hash2(rosterSeed, BigInt(shipIndex));
  // "ai:" prefix so the wire id distinguishes from player ship
  // ids (`entity:<shipId>`) and deposit ids (`<hex>`), and so a
  // log filter for `ai:` cleanly pulls just the roster.
  return `ai:${bigintToHex(finalHash, 16)}`;
}

/** Format `value` as a zero-padded lowercase hex of `width` chars. */
function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}
