import { describe, expect, it } from 'vitest';
import {
  SYSTEM_FRAME,
  azimuthalStretch,
  colatitude,
  convertKinematics,
  inSurfaceRange,
  maxFlatRadius,
  surfaceBasis,
  surfaceBasisQuat,
  surfaceToSystem,
  surfaceVectorToSystem,
  systemToSurface,
  systemVectorToSurface,
} from '@shared/physics/frames.ts';
import { Rng } from '@shared/random.ts';
import {
  add,
  distance,
  fromAxisAngle,
  length,
  mulMat3,
  normalize,
  normalizeQuat,
  rotateVector,
  scale,
  sub,
} from '@shared/physics/vec.ts';
import { MAX_COLATITUDE } from '@shared/physics/worldConstants.ts';

import { CENTER, R, at, body, planet } from '@shared/physics/testkit.ts';
const SIN = Math.sin;
const COS = Math.cos;

describe('surface projection', () => {
  it('maps the pole to the flat origin with y as altitude', () => {
    expect(systemToSurface(body, at(0, 0, 1234))).toEqual({
      x: 0,
      y: expect.closeTo(1234, 6) as number,
      z: 0,
    });
  });

  it('is azimuthal-equidistant: flat radius = R * theta, azimuth preserved', () => {
    const flat = systemToSurface(body, at(Math.PI / 2, 0.6, 500));
    expect(Math.sqrt(flat.x * flat.x + flat.z * flat.z)).toBeCloseTo(R * (Math.PI / 2), 5);
    expect(Math.atan2(flat.z, flat.x)).toBeCloseTo(0.6, 9);
    expect(flat.y).toBeCloseTo(500, 6);
  });

  it('round-trips positions with error under 1 mm at 80 km radius (pole, equator, near the limit)', () => {
    const rng = new Rng(7n);
    let worst = 0;
    const thetas = [
      0,
      1e-9,
      1e-6,
      1e-3,
      0.01,
      0.3,
      1,
      Math.PI / 2,
      2,
      2.6,
      0.96 * Math.PI,
      MAX_COLATITUDE,
    ];
    for (const theta of thetas) {
      for (let i = 0; i < 400; i++) {
        const phi = rng.nextRange(-Math.PI, Math.PI);
        const alt = rng.nextRange(-500, 12_000);
        const p = at(theta, phi, alt);
        const back = surfaceToSystem(body, systemToSurface(body, p));
        worst = Math.max(worst, distance(p, back));
      }
    }
    console.log(`position round-trip worst error: ${(worst * 1000).toExponential(2)} mm`);
    expect(worst).toBeLessThan(1e-3);
  });

  it('round-trips flat points too (flat -> system -> flat)', () => {
    const rng = new Rng(8n);
    for (let i = 0; i < 2000; i++) {
      const r = rng.nextRange(0, maxFlatRadius(body));
      const a = rng.nextRange(-Math.PI, Math.PI);
      const flat = { x: r * COS(a), y: rng.nextRange(-400, 12000), z: r * SIN(a) };
      const back = systemToSurface(body, surfaceToSystem(body, flat));
      expect(distance(flat, back)).toBeLessThan(1e-3);
    }
  });

  it('treats colatitudes beyond 0.97 pi as out of range', () => {
    expect(inSurfaceRange(body, at(MAX_COLATITUDE - 1e-6, 0, 100))).toBe(true);
    expect(inSurfaceRange(body, at(MAX_COLATITUDE + 1e-3, 0, 100))).toBe(false);
    expect(inSurfaceRange(body, at(Math.PI, 0, 100))).toBe(false);
    expect(colatitude(body, at(1.0, 2.0, 5))).toBeCloseTo(1.0, 12);
    expect(maxFlatRadius(body)).toBeCloseTo(R * MAX_COLATITUDE, 6);
  });

  it('documents the distortion: azimuthal stretch grows from 1 at the pole to ~32x at the limit', () => {
    expect(azimuthalStretch(0)).toBe(1);
    expect(azimuthalStretch(Math.PI / 2)).toBeCloseTo(1.5708, 3);
    expect(azimuthalStretch(MAX_COLATITUDE)).toBeGreaterThan(30);
    expect(azimuthalStretch(MAX_COLATITUDE)).toBeLessThan(34);
  });

  it('chunk (0,0) region is at the pole: nearby flat points are nearly isometric there', () => {
    const a = surfaceToSystem(body, { x: 0, y: 0, z: 0 });
    const b = surfaceToSystem(body, { x: 256, y: 0, z: 0 });
    expect(distance(a, b)).toBeGreaterThan(255.99);
    expect(distance(a, b)).toBeLessThan(256.01);
  });
});

describe('vector and orientation conversion', () => {
  it('rotates vectors without stretching them, and round-trips', () => {
    const rng = new Rng(9n);
    for (let i = 0; i < 1000; i++) {
      const theta = rng.nextRange(0, MAX_COLATITUDE);
      const phi = rng.nextRange(-Math.PI, Math.PI);
      const flat = systemToSurface(body, at(theta, phi, rng.nextRange(0, 5000)));
      const v = {
        x: rng.nextRange(-300, 300),
        y: rng.nextRange(-300, 300),
        z: rng.nextRange(-300, 300),
      };
      const sysV = surfaceVectorToSystem(body, flat, v);
      expect(length(sysV)).toBeCloseTo(length(v), 9);
      const back = systemVectorToSurface(body, flat, sysV);
      expect(distance(back, v)).toBeLessThan(1e-9);
    }
  });

  it('maps flat up to the local up and flat radial to the direction away from the pole', () => {
    const p = at(1.1, 0.4, 0);
    const flat = systemToSurface(body, p);
    const up = normalize(sub(p, CENTER));
    expect(distance(surfaceVectorToSystem(body, flat, { x: 0, y: 1, z: 0 }), up)).toBeLessThan(
      1e-12,
    );
    const radial = { x: COS(0.4), y: 0, z: SIN(0.4) };
    const away = surfaceVectorToSystem(body, flat, radial);
    // Moving "away from the pole" increases colatitude.
    const stepped = add(p, scale(away, 10));
    expect(colatitude(body, stepped)).toBeGreaterThan(1.1);
    expect(Math.abs(away.x * up.x + away.y * up.y + away.z * up.z)).toBeLessThan(1e-12);
  });

  it('is a proper rotation (determinant +1) everywhere', () => {
    const rng = new Rng(10n);
    for (let i = 0; i < 300; i++) {
      const flat = { x: rng.nextRange(-1e5, 1e5), y: 100, z: rng.nextRange(-1e5, 1e5) };
      const m = surfaceBasis(body, flat);
      const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
      expect(det).toBeCloseTo(1, 12);
    }
  });

  it('keeps radial motion isometric but stretches azimuthal motion (the velocity rule ignores that)', () => {
    const theta = Math.PI / 2;
    const flat = systemToSurface(body, at(theta, 0, 0));
    const d = 1;
    const radialStep = distance(
      surfaceToSystem(body, flat),
      surfaceToSystem(body, { ...flat, x: flat.x + d }),
    );
    const tangentStep = distance(
      surfaceToSystem(body, flat),
      surfaceToSystem(body, { ...flat, z: flat.z + d }),
    );
    expect(radialStep).toBeCloseTo(1, 4);
    expect(tangentStep).toBeCloseTo(1 / azimuthalStretch(theta), 4); // true ground covered per flat metre
    // Velocity conversion deliberately preserves the flat speed instead:
    const v = surfaceVectorToSystem(body, flat, { x: 0, y: 0, z: 1 });
    expect(length(v)).toBeCloseTo(1, 12);
  });

  it('converts orientation consistently with vectors: rotate-then-convert equals convert-then-rotate', () => {
    const rng = new Rng(11n);
    for (let i = 0; i < 300; i++) {
      const flat = systemToSurface(body, at(rng.nextRange(0, 2.5), rng.nextRange(-3, 3), 800));
      const qFlat = normalizeQuat(
        fromAxisAngle(
          normalize({ x: rng.nextRange(-1, 1), y: rng.nextRange(-1, 1), z: rng.nextRange(-1, 1) }),
          rng.nextRange(0, 6),
        ),
      );
      const local = { x: 0.3, y: -0.5, z: -1 };
      const viaFlat = surfaceVectorToSystem(body, flat, rotateVector(qFlat, local));
      const sys = convertKinematics(
        { pos: flat, vel: { x: 0, y: 0, z: 0 }, quat: qFlat },
        body.id,
        SYSTEM_FRAME,
        [body],
      );
      expect(distance(rotateVector(sys.quat, local), viaFlat)).toBeLessThan(1e-9);
    }
  });

  it('round-trips full kinematics (pos < 1 mm, vel, quat) through the surface frame', () => {
    const rng = new Rng(12n);
    for (const theta of [0, 0.001, 0.5, Math.PI / 2, 2.8, MAX_COLATITUDE - 0.001]) {
      const pos = at(theta, rng.nextRange(-3, 3), 4000);
      const k = {
        pos,
        vel: { x: 120, y: -30, z: 77 },
        quat: normalizeQuat({ x: 0.1, y: 0.7, z: -0.2, w: 0.5 }),
      };
      const flat = convertKinematics(k, SYSTEM_FRAME, body.id, [body]);
      const back = convertKinematics(flat, body.id, SYSTEM_FRAME, [body]);
      expect(distance(back.pos, k.pos)).toBeLessThan(1e-3);
      expect(distance(back.vel, k.vel)).toBeLessThan(1e-9);
      expect(
        Math.abs(
          back.quat.x * k.quat.x +
            back.quat.y * k.quat.y +
            back.quat.z * k.quat.z +
            back.quat.w * k.quat.w,
        ),
      ).toBeCloseTo(1, 9);
    }
  });

  it('converts between two planets through the system frame and rejects unknown frames', () => {
    const other = planet({ id: '1111222233334444', center: { x: 0, y: 0, z: 30_000_000 } });
    const k = {
      pos: { x: 100, y: 500, z: -200 },
      vel: { x: 1, y: 2, z: 3 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    };
    const there = convertKinematics(k, body.id, other.id, [body, other]);
    const back = convertKinematics(there, other.id, body.id, [body, other]);
    expect(distance(back.pos, k.pos)).toBeLessThan(1e-3);
    expect(() => convertKinematics(k, body.id, 'ffffffffffffffff', [body])).toThrow(RangeError);
    expect(() => convertKinematics(k, body.id, body.id, [body])).not.toThrow();
  });

  it('identity basis at the pole', () => {
    const q = surfaceBasisQuat(body, { x: 0, y: 0, z: 0 });
    expect(distance(rotateVector(q, { x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 })).toBeLessThan(
      1e-12,
    );
    expect(mulMat3(surfaceBasis(body, { x: 0, y: 0, z: 0 }), { x: 1, y: 0, z: 0 }).x).toBeCloseTo(
      1,
      12,
    );
  });
});
