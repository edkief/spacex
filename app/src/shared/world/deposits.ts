/**
 * Resource deposits (TASK-37) — the deterministic placement of a system's
 * mineable ore deposits, shared verbatim by server and client.
 *
 * Positions are DERIVED, never stored (PRD §6, task note): `depositsFor` is
 * a pure function of (galaxySeed, system) — identical on client and server —
 * and the DB keeps only deltas (remaining amount, discovered flag) keyed by
 * the stable `depositId` / `depositSeq` (see server/db `deposits` table).
 *
 * Contract (AC):
 * - up to DEPOSIT_MAX_PER_SYSTEM (120) deposits per system;
 * - {depositId, planetId, pos, resourceId, amount 10..50, discovered: false};
 * - Poisson-ish rejection scatter over solid (habitable/rocky) terrain only —
 *   never in atmosphere space, never below terrain (pos.y = heightAt);
 * - slope > 30° rejected, min horizontal spacing 200 m;
 * - resource type weighted (iron 40 / copper 30 / rare-earth 20 / crystal 10).
 */

import { Rng, hash2, seedFromString } from '../random';
import { CELL_SIZE_M, heightfieldChannels } from '../galaxy/surface';
import { planetAnchor } from '../galaxy/planets';
import { pickResource } from '../resources';
import type { Planet, SystemGen } from '../galaxy/types';
import type { ResourceId } from '../inventory';
import type { Vec3 } from '../physics/vec';

/** Hard cap on deposits per system (bounded economy — task note). */
export const DEPOSIT_MAX_PER_SYSTEM = 120;
/**
 * Wire entity-id prefix for deposit entities: the server spawns
 * `deposit:<depositId>` (seeded) / `deposit:dev<n>` (dev hook) — the client
 * strips it to match the seed-derived depositId.
 */
export const DEPOSIT_ENTITY_PREFIX = 'deposit:';
/** Min horizontal spacing between two deposits on the same planet (m). */
export const DEPOSIT_MIN_SPACING_M = 200;
/** A player within this radius (m) DISCOVERS a deposit (server-side flag). */
export const DEPOSIT_DISCOVERY_RADIUS_M = 50;
/** Client render + server snapshot streaming radius (m). */
export const DEPOSIT_RENDER_RANGE_M = 500;
/** Max surface slope (degrees) a deposit will sit on. */
export const DEPOSIT_SLOPE_MAX_DEG = 30;
/** Seeded initial quantity range (inclusive). */
export const DEPOSIT_AMOUNT_MIN = 10;
export const DEPOSIT_AMOUNT_MAX = 50;

/** Scatter radius (m) around a planet's surface anchor. */
const DEPOSIT_SCATTER_RADIUS_M = 2_000;
/** Rejection attempts per due deposit (bounded; Poisson-ish thinning). */
const DEPOSIT_ATTEMPTS_PER_DEPOSIT = 24;

/** One seeded deposit (the client derives the SAME list from the same seed). */
export interface Deposit {
  /** Stable seed-derived id `${systemId}:${depositSeq}` (DB key suffix). */
  depositId: string;
  /** Seed-derived sequence index (0-based, orbital/acceptance order). */
  depositSeq: number;
  planetId: string;
  /** World position; y is EXACTLY the terrain height at (x, z). */
  pos: Vec3;
  resourceId: ResourceId;
  /** Initial extractable quantity (10..50). */
  amount: number;
  /** True once any player came within DEPOSIT_DISCOVERY_RADIUS_M. */
  discovered: boolean;
}

/**
 * Bilinear sample of a planet's planet-wide height field (the SAME field
 * TerrainContext samples server-side: integer cell heights, 5 m grid).
 * This is the authoritative "heightAt" for deposit placement + the surface
 * placement test.
 */
export function planetHeightAt(
  seed: string,
  planet: Pick<Planet, 'id' | 'radiusKm'>,
  x: number,
  z: number,
): number {
  return planetField(seed, planet).hAt(x, z);
}

/**
 * A PERSISTENT planet height sampler (the same field as `planetHeightAt`).
 * Unlike `planetHeightAt` — which builds a fresh per-call cell cache — this
 * keeps ONE cache alive for the life of the caller, so repeated samples near
 * a spot (a drone circling its orbit) hit the memo and cost ~nothing. The
 * shard holds one per planet for the drone hover (per tick, per drone).
 */
export function planetHeightSampler(
  seed: string,
  planet: Pick<Planet, 'id' | 'radiusKm'>,
): (x: number, z: number) => number {
  return planetField(seed, planet).hAt;
}

/**
 * One planet's height field with a memoized integer cell cache + bilinear
 * `hAt` (matches TerrainContext.heightAt) and a cached two-cell slope. The
 * cache is per placement pass, so a whole system derives in one shot.
 */
function planetField(seed: string, planet: Pick<Planet, 'id' | 'radiusKm'>) {
  const { height, amp } = heightfieldChannels(seed, planet);
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
    const h00 = cell(cx, cz);
    const h10 = cell(cx + 1, cz);
    const h01 = cell(cx, cz + 1);
    const h11 = cell(cx + 1, cz + 1);
    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * tz;
  };
  /** Slope (radians) at a cell-CENTERED position (two-cell = 10 m arms). */
  const slopeAt = (cellX: number, cellZ: number): number => {
    const gx = Math.abs(cell(cellX + 2, cellZ) - cell(cellX - 2, cellZ));
    const gz = Math.abs(cell(cellX, cellZ + 2) - cell(cellX, cellZ - 2));
    return Math.atan(Math.max(gx, gz) / (4 * CELL_SIZE_M));
  };
  return { hAt, slopeAt };
}

/**
 * Eligible terrain: solid surfaces only — landable planets that are not
 * oceans (no underwater deposits) and not gas giants (no surface at all).
 * "Habitable/rocky" per the spec: terran, rocky and ice worlds.
 */
function isDepositPlanet(planet: Planet): boolean {
  return planet.landable && planet.class !== 'ocean' && planet.class !== 'gas';
}

/** Per-planet due counts: the system cap split evenly (remainder first). */
function planetBudgets(eligibleCount: number): number[] {
  const base = Math.floor(DEPOSIT_MAX_PER_SYSTEM / eligibleCount);
  const out = new Array<number>(eligibleCount).fill(base);
  for (let i = 0; i < DEPOSIT_MAX_PER_SYSTEM - base * eligibleCount; i++) out[i] += 1;
  return out;
}

/**
 * Place the deposits DUE to one planet around its surface anchor. Pure and
 * deterministic in (seed, systemId, planet, index): candidates are
 * cell-aligned world positions inside the scatter radius, rejected when
 * steeper than DEPOSIT_SLOPE_MAX_DEG or closer than DEPOSIT_MIN_SPACING_M
 * to an accepted neighbor. Returns accepted world positions.
 */
function scatterPlanet(
  seed: string,
  systemId: string,
  planet: Planet,
  index: number,
  due: number,
): Vec3[] {
  const anchor = planetAnchor(index);
  const sub = hash2(
    hash2(seedFromString(seed), seedFromString(systemId)),
    seedFromString(`deposits:${planet.id}`),
  );
  const rng = new Rng(sub);
  const field = planetField(seed, planet);
  const cellRange = Math.floor(DEPOSIT_SCATTER_RADIUS_M / CELL_SIZE_M);
  const anchorCellX = Math.floor(anchor.x / CELL_SIZE_M);
  const anchorCellZ = Math.floor(anchor.z / CELL_SIZE_M);
  const maxSlope = (DEPOSIT_SLOPE_MAX_DEG * Math.PI) / 180;
  const accepted: Vec3[] = [];
  const tries = Math.min(4000, due * DEPOSIT_ATTEMPTS_PER_DEPOSIT);
  for (let i = 0; i < tries && accepted.length < due; i++) {
    const cellX = anchorCellX + rng.nextInt(cellRange * 2 + 1) - cellRange;
    const cellZ = anchorCellZ + rng.nextInt(cellRange * 2 + 1) - cellRange;
    // Cheap checks first (spacing is a hypot vs the accepted list), then
    // the noisier slope rejection.
    const x = cellX * CELL_SIZE_M;
    const z = cellZ * CELL_SIZE_M;
    const tooClose = accepted.some((p) => Math.hypot(p.x - x, p.z - z) < DEPOSIT_MIN_SPACING_M);
    if (tooClose) continue;
    if (field.slopeAt(cellX, cellZ) > maxSlope) continue;
    accepted.push({ x, y: field.hAt(x, z), z });
  }
  return accepted;
}

/** Per-system cache: derivation touches the noise channels and is not free. */
const depositCache = new Map<string, Deposit[]>();

/** Test hook: clear the per-system cache (cold-derivation determinism tests). */
export function __resetDepositCache(): void {
  depositCache.clear();
}

/**
 * The system's deterministic deposit list (AC): up to 120, on solid
 * habitable/rocky terrain, 200 m apart, 10..50 units each, weighted
 * resources, `discovered: false`. Cached per (seed, systemId).
 *
 * Deposit ids are STABLE across restarts and platforms — `${systemId}:${seq}`
 * — so the DB delta rows (keyed by (system_id, deposit_seq)) always map back
 * to exactly this list.
 */
export function depositsFor(
  galaxySeed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): Deposit[] {
  const key = `${galaxySeed}\u0000${system.systemId}`;
  const cached = depositCache.get(key);
  if (cached) return cached;

  const eligible: Array<{ planet: Planet; index: number }> = [];
  system.planets.forEach((planet, index) => {
    if (isDepositPlanet(planet)) eligible.push({ planet, index });
  });
  const budgets = eligible.length > 0 ? planetBudgets(eligible.length) : [];
  const rng = new Rng(
    hash2(
      hash2(seedFromString(galaxySeed), seedFromString(system.systemId)),
      seedFromString('deposits'),
    ),
  );
  const out: Deposit[] = [];
  let seq = 0;
  eligible.forEach(({ planet, index }, i) => {
    for (const pos of scatterPlanet(galaxySeed, system.systemId, planet, index, budgets[i])) {
      out.push({
        depositId: `${system.systemId}:${seq}`,
        depositSeq: seq,
        planetId: planet.id,
        pos,
        resourceId: pickResource(rng),
        amount: DEPOSIT_AMOUNT_MIN + rng.nextInt(DEPOSIT_AMOUNT_MAX - DEPOSIT_AMOUNT_MIN + 1),
        discovered: false,
      });
      seq += 1;
    }
  });
  depositCache.set(key, out);
  return out;
}
