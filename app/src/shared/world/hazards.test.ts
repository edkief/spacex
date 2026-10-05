import { describe, expect, it } from 'vitest';

import { generateSystem } from '../galaxy/system';
import { padsForSystem } from './pads';
import {
  DRONE_MAX_PER_CELL,
  DRONE_MIN_PER_CELL,
  EXPOSURE_MAX,
  HAZARD_KINDS,
  HAZARD_MAX_PER_PLANET,
  HAZARD_MIN_SPACING_M,
  HAZARD_RADIUS_MAX,
  HAZARD_RADIUS_MIN,
  HAZARD_SAFE_ZONE_M,
  RECOVER_MS,
  RAD_DRAIN_PER_S,
  STORM_DRAIN_PER_S,
  EXPOSURE_REGEN_PER_S,
  FULL_EXPOSURE,
  hazardAt,
  hazardsFor,
  tickExposure,
  __resetHazardCache,
} from './hazards';

const SEED = 'hazards-test-seed';

/** Three distinct real systems of one galaxy (different star ids). */
const SYSTEMS = [
  generateSystem(SEED, 'star-a'),
  generateSystem(SEED, 'star-b'),
  generateSystem(SEED, 'star-c'),
];

describe('hazardsFor: seeded placement (TASK-48 AC)', () => {
  const STAR_IDS = ['star-a', 'star-b', 'star-c'];

  it.each(SYSTEMS.map((s, i) => [s, STAR_IDS[i]] as const))(
    'system %s.systemId: deterministic list (same seed → identical, cache-cold)',
    (system, starId) => {
      __resetHazardCache();
      const a = hazardsFor(SEED, system);
      __resetHazardCache();
      // Re-derive from a FRESH generateSystem call + cold cache.
      const b = hazardsFor(SEED, generateSystem(SEED, starId));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: ≤ 8 cells per planet, radius 100-400, known kind, drone count 2-4 only on drone cells',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      const hazards = hazardsFor(SEED, system);
      expect(hazards.length).toBeGreaterThan(0);
      const byPlanet = new Map<string, number>();
      for (const h of hazards) {
        expect(hazards.length, 'total cells bounded by 8 x planet count').toBeLessThanOrEqual(
          8 * system.planets.length,
        );
        byPlanet.set(h.planetId, (byPlanet.get(h.planetId) ?? 0) + 1);
        expect(HAZARD_KINDS).toContain(h.kind);
        expect(h.radius).toBeGreaterThanOrEqual(HAZARD_RADIUS_MIN);
        expect(h.radius).toBeLessThanOrEqual(HAZARD_RADIUS_MAX);
        expect([1, 1.5, 2]).toContain(h.intensity);
        if (h.kind === 'drones') {
          expect(h.droneCount).toBeGreaterThanOrEqual(DRONE_MIN_PER_CELL);
          expect(h.droneCount).toBeLessThanOrEqual(DRONE_MAX_PER_CELL);
        } else {
          expect(h.droneCount).toBe(0);
        }
        expect(Number.isFinite(h.pos.x)).toBe(true);
        expect(Number.isFinite(h.pos.y)).toBe(true);
        expect(Number.isFinite(h.pos.z)).toBe(true);
      }
      for (const count of byPlanet.values()) {
        expect(count, 'up to 8 cells per planet').toBeLessThanOrEqual(HAZARD_MAX_PER_PLANET);
      }
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: no hazard disc inside the 300 m pad safe zone',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      const hazards = hazardsFor(SEED, system);
      const pads = padsForSystem(SEED, system);
      for (const h of hazards) {
        const planetPads = pads.filter((p) => p.planetId === h.planetId);
        for (const pad of planetPads) {
          const d = Math.hypot(h.pos.x - pad.pos.x, h.pos.z - pad.pos.z);
          // The CENTER rule (AC: ≥ 300 m) — the derivation enforces the
          // stronger whole-disc rule (d - radius ≥ 300 m).
          expect(d, `${h.hazardId} vs ${pad.padId}`).toBeGreaterThanOrEqual(HAZARD_SAFE_ZONE_M);
          expect(d - h.radius, `${h.hazardId} disc edge vs ${pad.padId}`).toBeGreaterThanOrEqual(
            HAZARD_SAFE_ZONE_M - 1e-9,
          );
        }
      }
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))('%s: min cell spacing ≥ 250 m per planet', (systemId) => {
    const system = SYSTEMS.find((s) => s.systemId === systemId)!;
    const hazards = hazardsFor(SEED, system);
    const byPlanet = new Map<string, typeof hazards>();
    for (const h of hazards) {
      const arr = byPlanet.get(h.planetId) ?? [];
      arr.push(h);
      byPlanet.set(h.planetId, arr);
    }
    for (const arr of byPlanet.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const dist = Math.hypot(arr[i].pos.x - arr[j].pos.x, arr[i].pos.z - arr[j].pos.z);
          expect(dist, `cells ${arr[i].hazardId}/${arr[j].hazardId}`).toBeGreaterThanOrEqual(
            HAZARD_MIN_SPACING_M - 1e-9,
          );
        }
      }
    }
  });
});

describe('tickExposure: accumulation / regen / knock-down (TASK-48 AC, exact math)', () => {
  const DT = 0.1; // 10 Hz

  it('drains 2/s in a storm and 5/s in a rad zone from a full pool', () => {
    let s = FULL_EXPOSURE;
    for (let i = 0; i < 10; i++) s = tickExposure(s, 'storm', DT, 1000 + i * 100).state;
    expect(s.exposure).toBeCloseTo(EXPOSURE_MAX - STORM_DRAIN_PER_S, 9);
    s = FULL_EXPOSURE;
    for (let i = 0; i < 10; i++) s = tickExposure(s, 'radzone', DT, 1000 + i * 100).state;
    expect(s.exposure).toBeCloseTo(EXPOSURE_MAX - RAD_DRAIN_PER_S, 9);
  });

  it('regens 5/s outside hazards, capped at EXPOSURE_MAX', () => {
    let s = { exposure: 10, recoveringUntilMs: 0 };
    for (let i = 0; i < 10; i++) s = tickExposure(s, null, DT, 1000 + i * 100).state;
    expect(s.exposure).toBeCloseTo(10 + EXPOSURE_REGEN_PER_S, 9);
    s = { exposure: EXPOSURE_MAX, recoveringUntilMs: 0 };
    s = tickExposure(s, null, 10, 0).state;
    expect(s.exposure).toBe(EXPOSURE_MAX);
  });

  // Knock-down TIMING tests run at the sim's 1 Hz damage cadence (AC: damage
  // ticks in the sim at 1 Hz): whole-second drains are exact integers, so the
  // knock tick is bit-exact (no float boundary drift).
  const HZ = 1;

  it('knock-down timing is exact: a full pool in a rad zone down at exactly 10 s', () => {
    let s = FULL_EXPOSURE;
    let knockCount = 0;
    let knockAtMs = -1;
    for (let t = 0; t < 10; t++) {
      const r = tickExposure(s, 'radzone', HZ, 1000 + t * 1000);
      s = r.state;
      if (r.knocked) {
        knockCount += 1;
        if (knockAtMs === -1) knockAtMs = 1000 + t * 1000;
      }
    }
    // 50 exposure / (5/s) = exactly 10 s → knocked on the 10th tick (t = 9),
    // exactly once per knock-down episode (re-knock is asserted below).
    expect(knockAtMs).toBe(1000 + 9 * 1000);
    expect(knockCount).toBe(1);
    expect(s.exposure).toBe(0);
    expect(s.recoveringUntilMs).toBe(knockAtMs + RECOVER_MS);
  });

  it('storm knock-down at exactly 25 s (50 / 2 per s)', () => {
    let s = FULL_EXPOSURE;
    let knockAtMs = -1;
    for (let t = 0; t < 40; t++) {
      const r = tickExposure(s, 'storm', HZ, 1000 + t * 1000);
      s = r.state;
      if (r.knocked) {
        knockAtMs = 1000 + t * 1000;
        break;
      }
    }
    expect(knockAtMs).toBe(1000 + 24 * 1000); // the 25th tick
  });

  it('no regen while recovering; state exits recovering at the deadline', () => {
    let s = FULL_EXPOSURE;
    let knockAtMs = -1;
    for (let t = 0; t < 10; t++) {
      const r = tickExposure(s, 'radzone', HZ, 1000 + t * 1000);
      s = r.state;
      if (r.knocked) knockAtMs = 1000 + t * 1000;
    }
    expect(knockAtMs).toBe(1000 + 9 * 1000);
    const deadline = knockAtMs + RECOVER_MS;
    // Inside a hazard while recovering: NO regen (still 0 before the deadline).
    const held = tickExposure(s, 'radzone', HZ, deadline - 1).state;
    expect(held.exposure).toBe(0);
    expect(held.recoveringUntilMs).toBe(deadline);
    // Still INSIDE at the deadline: the empty pool re-knocks immediately
    // (staying in a hazard keeps you down, one knock per RECOVER_MS).
    const after = tickExposure(s, 'radzone', HZ, deadline);
    expect(after.knocked).toBe(true);
    expect(after.state.exposure).toBe(0);
    expect(after.state.recoveringUntilMs).toBe(deadline + RECOVER_MS);
    // Outside at the deadline: pure regen.
    const regen = tickExposure(s, null, HZ, deadline).state;
    expect(regen.exposure).toBeCloseTo(EXPOSURE_REGEN_PER_S, 9);
  });
});

describe('hazardAt: cell membership (TASK-48 AC)', () => {
  const hazards = hazardsFor(SEED, SYSTEMS[0]);
  const cell = hazards[0];

  it('reports the cell at its center and just inside the radius, clear just outside', () => {
    expect(hazardAt(hazards, { ...cell.pos }, cell.planetId)?.hazardId).toBe(cell.hazardId);
    const edge = { x: cell.pos.x + (cell.radius - 1), y: cell.pos.y, z: cell.pos.z };
    expect(hazardAt(hazards, edge, cell.planetId)?.hazardId).toBe(cell.hazardId);
    const out = { x: cell.pos.x + cell.radius + 1, y: cell.pos.y, z: cell.pos.z };
    expect(hazardAt(hazards, out, cell.planetId)).toBeUndefined();
  });

  it('is planet-scoped (a foreign planetId never matches)', () => {
    expect(hazardAt(hazards, { ...cell.pos }, 'no-such-planet')).toBeUndefined();
  });
});
