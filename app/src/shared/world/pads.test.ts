import { describe, expect, it } from 'vitest';

import { CELL_SIZE_M, CHUNK_SIZE, generateSurfaceChunk } from '../galaxy/surface';
import { planetAnchor } from '../galaxy/planets';
import { ATMOSPHERE_BOUNDARY_M } from '../physics/atmosphere';
import type { Planet, SystemGen } from '../galaxy/types';
import type { Vec3 } from '../physics/vec';
import {
  applyVtolAssist,
  horizontalDistanceM,
  PAD_FLAT_BLEND_OUTER_M,
  PAD_RADIUS_M,
  PAD_RELEASE_RADIUS_M,
  padSurfaceHeight,
  padsForSystem,
  resolvePadTarget,
  satisfiesDock,
  vtolAssistActive,
  VTOL_ASSIST_DAMPING,
  VTOL_ASSIST_RANGE_M,
  VTOL_ASSIST_SPEED_MAX_M_S,
  DOCK_ALTITUDE_TOLERANCE_M,
  DOCK_VERTICAL_SPEED_MAX_M_S,
  type PadInfo,
} from './pads';

/**
 * TASK-29.1: unit tests for the pure pad math (shared/world/pads.ts).
 *
 * Covers the committed behavior verbatim:
 * - padsForSystem: one pad per landable planet, deterministic per (seed,
 *   system), world position = planet anchor + chunk (0,0) local offset
 *   (i.e. INSIDE the planet's atmosphere), height = terrain at the pad
 *   position, cached per (seed, systemId);
 * - resolvePadTarget: nearest pad within 20 m, hysteresis on the boundary
 *   (19 m in / 21 m out, tracked pad kept to 25 m), tie-break on padId,
 *   at most one pad;
 * - satisfiesDock clause by clause (range ≤ 20, regime exactly 'surface',
 *   |vel.y| < 2 strict, altitude within 1 m);
 * - vtolAssistActive gate by gate (up > 0, speed < 50 strict, ≤ 100 m) and
 *   applyVtolAssist (x/z ×0.5, y untouched);
 * - padSurfaceHeight: flat disc at pad height ≤ 20 m, exact raised-cosine
 *   midpoint at 25 m, real terrain beyond 30 m.
 */

const SEED = 'PAD-UNIT-SEED';
const OTHER_SEED = 'PAD-UNIT-SEED-2';

function makePlanet(id: string, landable: boolean): Planet {
  return {
    id,
    name: id,
    class: 'terran',
    radiusKm: 3000,
    hasAtmosphere: true,
    landable,
    dockCount: 1,
    resourceTypes: ['iron'],
    aiRoster: { count: 1, classes: ['scout'] },
  };
}

/** One landable planet at orbital slot 0. */
const PLANET = makePlanet('planet-a', true);
const SYSTEM: SystemGen = {
  systemId: 'sys-pad-unit',
  name: 'Pad unit system',
  star: { class: 'G', name: 'Padstar' },
  planets: [PLANET],
};

/** A synthetic pad (no chunk generation) at world (x, 0, z). */
function mkPad(id: string, x = 0, z = 0, y = 0): PadInfo {
  return {
    padId: id,
    planetId: 'p',
    pos: { x, y, z },
    normal: { x: 0, y: 1, z: 0 },
    radius: PAD_RADIUS_M,
  };
}

/** A position at horizontal distance d from the pad (positive x axis). */
function at(d: number, pad: PadInfo, y = 0): Vec3 {
  return { x: pad.pos.x + d, y: pad.pos.y + y, z: pad.pos.z };
}

describe('padsForSystem', () => {
  it('derives exactly one pad per landable planet, in orbital-slot order', () => {
    const multi = makePlanet('planet-b', true);
    const gas = { ...makePlanet('planet-gas', false), class: 'gas' as const };
    const sys: SystemGen = {
      systemId: 'sys-pad-multi',
      name: 'Multi',
      star: { class: 'G', name: 'M' },
      planets: [PLANET, gas, multi], // slot 0 landable, 1 not, 2 landable
    };
    const pads = padsForSystem(SEED, sys);
    expect(pads).toHaveLength(2);
    expect(pads.map((p) => p.planetId)).toEqual(['planet-a', 'planet-b']);
    // One pad per planet, never two for the same planet.
    const ids = new Set(pads.map((p) => p.planetId));
    expect(ids.size).toBe(pads.length);
    for (const pad of pads) {
      expect(pad.radius).toBe(PAD_RADIUS_M);
      expect(pad.normal).toEqual({ x: 0, y: 1, z: 0 });
      expect(pad.padId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is deterministic per (seed, system) and differs across seeds', () => {
    const a = padsForSystem(SEED, SYSTEM);
    const b = padsForSystem(SEED, SYSTEM);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const other = padsForSystem(OTHER_SEED, SYSTEM);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(a));
  });

  it('places the pad at planetAnchor(index) + the chunk (0,0) local offset, inside the atmosphere', () => {
    const pad = padsForSystem(SEED, SYSTEM)[0];
    const local = generateSurfaceChunk(SEED, PLANET, 0, 0).landingPads[0];
    const anchor = planetAnchor(0);
    expect(local).toBeTruthy();
    expect(pad.pos.x).toBe(anchor.x + local.x);
    expect(pad.pos.z).toBe(anchor.z + local.z);
    expect(pad.padId).toBe(local.id);
    // The anchor sits on the y = 0 surface plane: the 3D anchor distance is
    // what the regime machine uses to resolve the atmosphere.
    const d = Math.hypot(pad.pos.x - anchor.x, pad.pos.y, pad.pos.z - anchor.z);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(ATMOSPHERE_BOUNDARY_M);
  });

  it('sets the pad height to the terrain cell height at the pad world position', () => {
    const pad = padsForSystem(SEED, SYSTEM)[0];
    const cellX = Math.floor(pad.pos.x / CELL_SIZE_M);
    const cellZ = Math.floor(pad.pos.z / CELL_SIZE_M);
    const cX = Math.floor(cellX / CHUNK_SIZE);
    const cZ = Math.floor(cellZ / CHUNK_SIZE);
    const chunk = generateSurfaceChunk(SEED, PLANET, cX, cZ);
    const h = chunk.heightmap[(cellZ - cZ * CHUNK_SIZE) * CHUNK_SIZE + (cellX - cX * CHUNK_SIZE)];
    expect(pad.pos.y).toBe(h);
  });

  it('is cached per (seed, systemId): the second call returns the same array', () => {
    const a = padsForSystem(SEED, SYSTEM);
    const sameSystem = { ...SYSTEM, planets: [PLANET] }; // same systemId, new object
    const b = padsForSystem(SEED, sameSystem);
    expect(b).toBe(a);
    // A different system id derives independently (not the same reference).
    const other: SystemGen = { ...SYSTEM, systemId: 'sys-pad-unit-b' };
    expect(padsForSystem(SEED, other)).not.toBe(a);
  });
});

describe('resolvePadTarget', () => {
  const pad = mkPad('pad-1');

  it('acquires the nearest pad within 20 m (boundary inclusive)', () => {
    expect(resolvePadTarget(at(19, pad), [pad], null)?.padId).toBe('pad-1');
    expect(resolvePadTarget(at(PAD_RADIUS_M, pad), [pad], null)?.padId).toBe('pad-1');
    // Untracked beyond the acquisition radius: no pad.
    expect(resolvePadTarget(at(PAD_RADIUS_M + 0.1, pad), [pad], null)).toBeUndefined();
  });

  it('hysteresis: a tracked pad is kept to 25 m and released beyond', () => {
    // An UNTRACKED ship never acquires in the 20–25 m band…
    expect(resolvePadTarget(at(21, pad), [pad], null)).toBeUndefined();
    // …but a TRACKED ship keeps it through the band (21 m and 25 m)…
    expect(resolvePadTarget(at(21, pad), [pad], 'pad-1')?.padId).toBe('pad-1');
    expect(resolvePadTarget(at(PAD_RELEASE_RADIUS_M, pad), [pad], 'pad-1')?.padId).toBe('pad-1');
    // …and releases just past it.
    expect(resolvePadTarget(at(PAD_RELEASE_RADIUS_M + 0.1, pad), [pad], 'pad-1')).toBeUndefined();
  });

  it('keeps the tracked pad even when another pad is closer', () => {
    const other = mkPad('pad-2', 10, 0); // 10 m from the ship at 24 m from pad-1
    const pos = at(24, pad);
    expect(resolvePadTarget(pos, [other, pad], 'pad-1')?.padId).toBe('pad-1');
    // …until the release radius is exceeded, then the nearest within 20 m wins.
    expect(resolvePadTarget(at(26, pad), [other, pad], 'pad-1')?.padId).toBe('pad-2');
  });

  it('breaks distance ties on padId (deterministic, lower id wins)', () => {
    const left = mkPad('pad-b', -10, 0);
    const right = mkPad('pad-a', 10, 0);
    const pos: Vec3 = { x: 0, y: 0, z: 0 }; // exactly 10 m from each
    expect(horizontalDistanceM(pos, left)).toBe(horizontalDistanceM(pos, right));
    const first = resolvePadTarget(pos, [left, right], null);
    const swapped = resolvePadTarget(pos, [right, left], null);
    expect(first?.padId).toBe('pad-a');
    expect(swapped?.padId).toBe('pad-a'); // independent of list order
  });

  it('returns at most one pad', () => {
    const a = mkPad('pad-a', -10, 0);
    const b = mkPad('pad-b', 10, 0);
    const c = mkPad('pad-c', 0, 9); // all within 20 m of the origin
    for (const pos of [{ x: 0, y: 0, z: 0 }, at(15, a), at(19, b)]) {
      const target = resolvePadTarget(pos, [a, b, c], null);
      expect(target).toBeDefined();
      expect(target).not.toBeInstanceOf(Array);
      expect(typeof target).toBe('object');
      expect(target!.padId).toMatch(/^pad-[abc]$/); // exactly one id, never two
    }
  });

  it('ignores an unknown current pad id (falls back to nearest-in-range)', () => {
    const other = mkPad('pad-2', 5, 0);
    expect(resolvePadTarget(at(12, pad), [pad, other], 'no-such-pad')?.padId).toBe('pad-2');
  });
});

describe('satisfiesDock', () => {
  const pad = mkPad('pad-1', 0, 0, 10); // pad surface at y = 10

  const base = {
    pos: { x: 0, y: 10, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    regime: 'surface',
  };

  it('accepts a ship resting on the pad surface', () => {
    expect(satisfiesDock(base.pos, base.vel, 'surface', pad)).toBe(true);
  });

  it('requires horizontal range ≤ 20 m (boundary inclusive)', () => {
    expect(satisfiesDock(at(19, pad), base.vel, 'surface', pad)).toBe(true);
    expect(satisfiesDock(at(PAD_RADIUS_M, pad), base.vel, 'surface', pad)).toBe(true);
    expect(satisfiesDock(at(PAD_RADIUS_M + 0.1, pad), base.vel, 'surface', pad)).toBe(false);
  });

  it('requires the regime to be exactly surface', () => {
    expect(satisfiesDock(base.pos, base.vel, 'surface', pad)).toBe(true);
    expect(satisfiesDock(base.pos, base.vel, 'atmosphere', pad)).toBe(false);
    expect(satisfiesDock(base.pos, base.vel, 'space', pad)).toBe(false);
  });

  it('requires |vel.y| < 2 u/s (strict, both directions)', () => {
    const v = (y: number): Vec3 => ({ x: 0, y, z: 0 });
    expect(satisfiesDock(base.pos, v(1.999), 'surface', pad)).toBe(true);
    expect(satisfiesDock(base.pos, v(-1.999), 'surface', pad)).toBe(true);
    expect(satisfiesDock(base.pos, v(DOCK_VERTICAL_SPEED_MAX_M_S), 'surface', pad)).toBe(false);
    expect(satisfiesDock(base.pos, v(-DOCK_VERTICAL_SPEED_MAX_M_S), 'surface', pad)).toBe(false);
  });

  it('requires altitude within 1 m of the pad height (inclusive)', () => {
    const y = (dy: number): Vec3 => ({ x: 0, y: 10 + dy, z: 0 });
    expect(satisfiesDock(y(1), base.vel, 'surface', pad)).toBe(true);
    expect(satisfiesDock(y(-1), base.vel, 'surface', pad)).toBe(true);
    expect(satisfiesDock(y(DOCK_ALTITUDE_TOLERANCE_M + 0.01), base.vel, 'surface', pad)).toBe(
      false,
    );
    expect(satisfiesDock(y(-DOCK_ALTITUDE_TOLERANCE_M - 0.01), base.vel, 'surface', pad)).toBe(
      false,
    );
  });
});

describe('vtolAssistActive / applyVtolAssist', () => {
  const pad = mkPad('pad-1');

  it('requires the VTOL key held (up > 0)', () => {
    expect(vtolAssistActive(0, 0, { x: 0, y: 0, z: 0 }, [pad])).toBe(false);
    expect(vtolAssistActive(0.5, 0, { x: 0, y: 0, z: 0 }, [pad])).toBe(true);
    expect(vtolAssistActive(1, 0, { x: 0, y: 0, z: 0 }, [pad])).toBe(true);
  });

  it('requires total speed < 50 u/s (strict)', () => {
    expect(vtolAssistActive(1, VTOL_ASSIST_SPEED_MAX_M_S - 0.01, { x: 0, y: 0, z: 0 }, [pad])).toBe(
      true,
    );
    expect(vtolAssistActive(1, VTOL_ASSIST_SPEED_MAX_M_S, { x: 0, y: 0, z: 0 }, [pad])).toBe(false);
  });

  it('requires horizontal range ≤ 100 m of some pad (boundary inclusive, altitude ignored)', () => {
    const far = mkPad('far', VTOL_ASSIST_RANGE_M + 0.1, 0);
    expect(vtolAssistActive(1, 0, { x: 0, y: 0, z: 0 }, [far])).toBe(false);
    const atRange = mkPad('at', VTOL_ASSIST_RANGE_M, 0);
    expect(vtolAssistActive(1, 0, { x: 0, y: 0, z: 0 }, [atRange])).toBe(true);
    // Range is HORIZONTAL: a pad 500 m straight up still counts.
    const overhead = mkPad('up', 0, 0);
    expect(
      vtolAssistActive(1, 0, { x: overhead.pos.x, y: 500, z: overhead.pos.z }, [overhead]),
    ).toBe(true);
    // No pads in the system: never active.
    expect(vtolAssistActive(1, 0, { x: 0, y: 0, z: 0 }, [])).toBe(false);
  });

  it('damps horizontal drift by ×0.5 per tick and leaves y untouched', () => {
    const input: Vec3 = { x: 4, y: 7, z: -6 };
    const out = applyVtolAssist(input);
    expect(out).toEqual({
      x: input.x * VTOL_ASSIST_DAMPING,
      y: input.y,
      z: input.z * VTOL_ASSIST_DAMPING,
    });
    expect(out).toEqual({ x: 2, y: 7, z: -3 });
    expect(out).not.toBe(input);
    expect(input).toEqual({ x: 4, y: 7, z: -6 }); // input never mutated
  });
});

describe('padSurfaceHeight', () => {
  const pad = mkPad('pad-1', 0, 0, 10); // pad surface at y = 10, ground at 30
  const GROUND = 30;

  it('is flat at the pad height within the 20 m disc (boundary inclusive, terrain ignored)', () => {
    expect(padSurfaceHeight(0, 0, GROUND, pad)).toBe(10);
    expect(padSurfaceHeight(12, 16, GROUND, pad)).toBe(10); // d = 20 (12-16-20 triangle)
    expect(padSurfaceHeight(-20, 0, GROUND, pad)).toBe(10);
  });

  it('blends with a raised cosine: exact midpoint at 25 m', () => {
    // t = (25 − 20) / 10 = 0.5 → s = (1 − cos(π/2)) / 2 = 0.5 → exact midpoint.
    expect(padSurfaceHeight(25, 0, GROUND, pad)).toBe((10 + GROUND) / 2);
  });

  it('returns the real terrain at and beyond the 30 m blend radius', () => {
    expect(padSurfaceHeight(PAD_FLAT_BLEND_OUTER_M, 0, GROUND, pad)).toBe(GROUND);
    expect(padSurfaceHeight(PAD_FLAT_BLEND_OUTER_M + 1, 0, GROUND, pad)).toBe(GROUND);
  });

  it('is monotonically blended between the disc edge and the blend radius', () => {
    let prev = padSurfaceHeight(PAD_RADIUS_M, 0, GROUND, pad);
    for (let d = 21; d <= 29; d += 1) {
      const h = padSurfaceHeight(d, 0, GROUND, pad);
      expect(h).toBeGreaterThan(prev);
      expect(h).toBeLessThan(GROUND);
      prev = h;
    }
  });

  it('falls back to the terrain when there is no pad', () => {
    expect(padSurfaceHeight(0, 0, GROUND, undefined)).toBe(GROUND);
  });
});
