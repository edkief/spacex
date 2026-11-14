import { describe, expect, it } from 'vitest';
import { chartToUnit } from '@shared/galaxy/chart.ts';
import {
  SYSTEM_FRAME,
  bodyOfFrame,
  convertKinematics,
  hemisphereOf,
  parseFrame,
  poleward,
  surfaceBasis,
  surfaceFrameId,
  surfaceScale,
  surfaceToSystem,
  surfaceVectorToSystem,
  systemToSurface,
  systemVectorToSurface,
} from '@shared/physics/frames.ts';
import { CENTER, NORTH, R, SOUTH, at, body } from '@shared/physics/testkit.ts';
import { cross, distance, dot, length, rotateVector, sub } from '@shared/physics/vec.ts';

const HEMIS = ['n', 's'] as const;
/** Colatitudes from the north pole: pole, mid-latitude, equator, and just past it (r = 1.05). */
const THETAS = [0, 0.3, 1.0, Math.PI / 2, 2 * Math.atan(1.05)];
const PHIS = [0, 0.7, 2.1, 4.0, 5.9];

describe('frame ids', () => {
  it('builds and parses surface frame ids', () => {
    expect(NORTH).toBe(`${body.id}:n`);
    expect(parseFrame(SOUTH)).toEqual({ planetId: body.id, hemisphere: 's' });
    expect(parseFrame(SYSTEM_FRAME)).toBeUndefined();
    expect(surfaceFrameId('0123456789abcdef', 's')).toBe('0123456789abcdef:s');
    expect(bodyOfFrame(NORTH, [body])).toBe(body);
    expect(bodyOfFrame(SYSTEM_FRAME, [body])).toBeUndefined();
  });
});

describe('stereographic charts', () => {
  it('puts each pole at its chart origin and the equator at flat radius 2R', () => {
    expect(systemToSurface(body, 'n', at(0, 0, 250))).toEqual({ x: 0, y: 250, z: 0 });
    const south = systemToSurface(body, 's', at(Math.PI, 0, 250));
    expect(Math.hypot(south.x, south.z)).toBeLessThan(1e-6);
    for (const hemisphere of HEMIS) {
      const flat = systemToSurface(body, hemisphere, at(Math.PI / 2, 1.3, 0));
      expect(Math.hypot(flat.x, flat.z)).toBeCloseTo(2 * R, 6);
    }
  });

  it('round-trips positions to well under a millimetre, including past the equator', () => {
    let worst = 0;
    for (const hemisphere of HEMIS) {
      for (const theta of THETAS) {
        for (const phi of PHIS) {
          for (const alt of [0, 137.5, 9000]) {
            const colat = hemisphere === 'n' ? theta : Math.PI - theta;
            const p = at(colat, phi, alt);
            const back = surfaceToSystem(body, hemisphere, systemToSurface(body, hemisphere, p));
            worst = Math.max(worst, distance(p, back));
          }
        }
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('agrees with the generation-side inverse (chartToUnit)', () => {
    const flat = { x: 31_000, y: 50, z: -77_000 };
    for (const hemisphere of HEMIS) {
      const n = chartToUnit(hemisphere, R, flat.x, flat.z);
      const p = surfaceToSystem(body, hemisphere, flat);
      expect(
        distance(p, {
          x: CENTER.x + n.x * (R + 50),
          y: n.y * (R + 50),
          z: CENTER.z + n.z * (R + 50),
        }),
      ).toBeLessThan(1e-9);
      expect(Math.abs(length(n) - 1)).toBeLessThan(1e-12);
    }
  });

  it('has scale 1 at the pole and 0.5 at the equator, the same in every direction (conformal)', () => {
    expect(surfaceScale(body, { x: 0, y: 0, z: 0 })).toBe(1);
    expect(surfaceScale(body, { x: 2 * R, y: 0, z: 0 })).toBeCloseTo(0.5, 12);
    for (const hemisphere of HEMIS) {
      for (const flat of [
        { x: 9000, y: 0, z: -4000 },
        { x: -70_000, y: 0, z: 90_000 },
        { x: 2 * R, y: 0, z: 100 },
      ]) {
        const k = surfaceScale(body, flat);
        const here = surfaceToSystem(body, hemisphere, flat);
        for (const [dx, dz] of [
          [1, 0],
          [0, 1],
          [0.6, -0.8],
        ] as const) {
          const there = surfaceToSystem(body, hemisphere, { x: flat.x + dx, y: 0, z: flat.z + dz });
          expect(distance(here, there)).toBeCloseTo(k, 4);
        }
      }
    }
  });

  it('throws at the antipode of a chart', () => {
    expect(() => systemToSurface(body, 'n', at(Math.PI, 0, 0))).toThrow(RangeError);
  });
});

describe('local basis', () => {
  it('is orthonormal and right-handed in both charts, with +y pointing away from the planet', () => {
    for (const hemisphere of HEMIS) {
      for (const flat of [
        { x: 0, y: 0, z: 0 },
        { x: 40_000, y: 10, z: -25_000 },
        { x: -150_000, y: 0, z: 60_000 },
      ]) {
        const m = surfaceBasis(body, hemisphere, flat);
        const ex = { x: m[0], y: m[3], z: m[6] };
        const up = { x: m[1], y: m[4], z: m[7] };
        const ez = { x: m[2], y: m[5], z: m[8] };
        for (const v of [ex, up, ez]) expect(length(v)).toBeCloseTo(1, 12);
        expect(dot(ex, up)).toBeCloseTo(0, 12);
        expect(dot(ex, ez)).toBeCloseTo(0, 12);
        expect(distance(cross(ex, up), ez)).toBeLessThan(1e-12);
        const outward = sub(surfaceToSystem(body, hemisphere, flat), body.center);
        expect(dot(up, outward)).toBeCloseTo(length(outward), 6);
      }
    }
  });

  it('points the flat axes along the directions flat motion actually moves on the sphere', () => {
    for (const hemisphere of HEMIS) {
      const flat = { x: 52_000, y: 0, z: -38_000 };
      const here = surfaceToSystem(body, hemisphere, flat);
      const m = surfaceBasis(body, hemisphere, flat);
      const stepX = sub(surfaceToSystem(body, hemisphere, { ...flat, x: flat.x + 1 }), here);
      const stepZ = sub(surfaceToSystem(body, hemisphere, { ...flat, z: flat.z + 1 }), here);
      const k = surfaceScale(body, flat);
      expect(dot(stepX, { x: m[0], y: m[3], z: m[6] }) / k).toBeCloseTo(1, 4);
      expect(dot(stepZ, { x: m[2], y: m[5], z: m[8] }) / k).toBeCloseTo(1, 4);
    }
  });

  it('rotates vectors without changing their length and inverts exactly', () => {
    const flat = { x: 12_345, y: 80, z: -54_321 };
    const v = { x: 30, y: -40, z: 25 };
    for (const hemisphere of HEMIS) {
      const sys = surfaceVectorToSystem(body, hemisphere, flat, v);
      expect(length(sys)).toBeCloseTo(length(v), 9);
      expect(distance(systemVectorToSurface(body, hemisphere, flat, sys), v)).toBeLessThan(1e-9);
    }
  });
});

describe('kinematics conversion', () => {
  const k = {
    pos: at(1.2, 0.9, 1500),
    vel: { x: 120, y: -30, z: 45 },
    quat: { x: 0.1825742, y: 0.3651484, z: 0.5477226, w: 0.7302967 },
  };

  it('round-trips system -> chart -> system for both charts', () => {
    for (const frame of [NORTH, SOUTH]) {
      const there = convertKinematics(k, SYSTEM_FRAME, frame, [body]);
      const back = convertKinematics(there, frame, SYSTEM_FRAME, [body]);
      expect(distance(back.pos, k.pos)).toBeLessThan(1e-6);
      expect(distance(back.vel, k.vel)).toBeLessThan(1e-9);
      const nose = { x: 0, y: 0, z: -1 };
      expect(distance(rotateVector(back.quat, nose), rotateVector(k.quat, nose))).toBeLessThan(
        1e-6,
      );
    }
  });

  it('converts chart to chart across the equator to the same physical state', () => {
    const north = convertKinematics(k, SYSTEM_FRAME, NORTH, [body]);
    const south = convertKinematics(north, NORTH, SOUTH, [body]);
    const direct = convertKinematics(k, SYSTEM_FRAME, SOUTH, [body]);
    expect(distance(south.pos, direct.pos)).toBeLessThan(1e-6);
    expect(distance(south.vel, direct.vel)).toBeLessThan(1e-9);
    expect(length(south.vel)).toBeCloseTo(length(k.vel), 9);
  });

  it('is the identity for the same frame and throws for unknown frames', () => {
    expect(convertKinematics(k, NORTH, NORTH, [body])).toBe(k);
    expect(() => convertKinematics(k, SYSTEM_FRAME, 'deadbeefdeadbeef:n', [body])).toThrow(
      RangeError,
    );
  });
});

describe('hemisphere helpers', () => {
  it('reports the hemisphere a point is over and its sine-latitude toward a pole', () => {
    expect(hemisphereOf(body, at(0.4, 1, 0))).toBe('n');
    expect(hemisphereOf(body, at(2.5, 1, 0))).toBe('s');
    expect(poleward(body, 'n', at(0, 0, 10))).toBeCloseTo(1, 12);
    expect(poleward(body, 's', at(0, 0, 10))).toBeCloseTo(-1, 12);
    expect(poleward(body, 'n', at(Math.PI / 2, 2, 10))).toBeCloseTo(0, 12);
  });
});
