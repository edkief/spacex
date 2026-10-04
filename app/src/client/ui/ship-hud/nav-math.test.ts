/**
 * TASK-51: nav-math unit tests — speed/altitude formatting (space shows
 * '—', atmosphere shows meters), regime tag switching, distance formatting,
 * and the bearing math (3D → screen arrow, including the above/below
 * component).
 */
import { describe, expect, it } from 'vitest';

import type { Quat, Vec3 } from '@shared/physics/vec';
import {
  bearingTo,
  elevLiftPx,
  formatAltitude,
  formatDistanceM,
  formatSpeed,
  regimeTag,
  speedMs,
  thrustYawDeg,
} from './nav-math';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
/** Identity attitude (nose = +Z, the flight model's thrust axis). */
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
/** Yaw +90° about Y (nose → +X). */
const YAW_90: Quat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

describe('speed readout', () => {
  it('formats |vel| in m/s with one decimal', () => {
    expect(speedMs({ x: 3, y: 4, z: 0 })).toBeCloseTo(5, 10);
    expect(formatSpeed({ x: 3, y: 4, z: 0 })).toBe('5.0 m/s');
    expect(formatSpeed({ x: 0, y: 0, z: 0 })).toBe('0.0 m/s');
    expect(formatSpeed({ x: 1, y: 1, z: 1 })).toBe('1.7 m/s');
  });
});

describe('altitude readout (regime-aware)', () => {
  it('shows meters in the atmosphere and on the surface', () => {
    expect(formatAltitude('atmosphere', { x: 0, y: 1234.4, z: 0 })).toBe('ALT 1234 m');
    expect(formatAltitude('surface', { x: 0, y: 12.9, z: 0 })).toBe('ALT 13 m');
  });
  it('shows "—" in space (altitude is meaningless there)', () => {
    expect(formatAltitude('space', { x: 0, y: 5000, z: 0 })).toBe('—');
  });
  it('never shows a negative altitude', () => {
    expect(formatAltitude('surface', { x: 0, y: -3, z: 0 })).toBe('ALT 0 m');
  });
});

describe('regime tag (server authority)', () => {
  it('maps the three regimes to SPACE / ATMOS / SURFACE', () => {
    expect(regimeTag('space')).toBe('SPACE');
    expect(regimeTag('atmosphere')).toBe('ATMOS');
    expect(regimeTag('surface')).toBe('SURFACE');
  });
});

describe('distance formatting', () => {
  it('shows meters below 1 km and kilometers (1 decimal) at/above', () => {
    expect(formatDistanceM(0)).toBe('0 m');
    expect(formatDistanceM(123.4)).toBe('123 m');
    expect(formatDistanceM(999)).toBe('999 m');
    expect(formatDistanceM(1000)).toBe('1.0 km');
    expect(formatDistanceM(12_400)).toBe('12.4 km');
    expect(formatDistanceM(482_000)).toBe('482.0 km');
  });
});

describe('bearing math (3D → screen arrow)', () => {
  it('dead-ahead target: zero yaw, zero elevation', () => {
    const b = bearingTo(ORIGIN, IDENTITY, { x: 0, y: 0, z: 1000 });
    expect(b.distM).toBeCloseTo(1000, 10);
    expect(b.yawDeg).toBeCloseTo(0, 10);
    expect(b.elevRad).toBeCloseTo(0, 10);
  });
  it('target to the LEFT of the nose is negative yaw (arrow rotates left)', () => {
    // Identity nose = +Z; screen right = -X, so world +X is screen-left.
    const b = bearingTo(ORIGIN, IDENTITY, { x: 1000, y: 0, z: 0 });
    expect(b.yawDeg).toBeCloseTo(-90, 6);
    expect(b.distM).toBeCloseTo(1000, 10);
  });
  it('target to the RIGHT of the nose is positive yaw', () => {
    const b = bearingTo(ORIGIN, IDENTITY, { x: -1000, y: 0, z: 0 });
    expect(b.yawDeg).toBeCloseTo(90, 6);
  });
  it('a behind target reads ~180°', () => {
    const b = bearingTo(ORIGIN, IDENTITY, { x: 0, y: 0, z: -500 });
    expect(Math.abs(b.yawDeg)).toBeCloseTo(180, 6);
  });
  it('rotates with the ship yaw (nose +X after a 90° turn, +X target = ahead)', () => {
    const b = bearingTo(ORIGIN, YAW_90, { x: 1000, y: 0, z: 0 });
    expect(b.yawDeg).toBeCloseTo(0, 6);
    // The OLD ahead direction (+Z) is now to the ship's RIGHT (+90°).
    const b2 = bearingTo(ORIGIN, YAW_90, { x: 0, y: 0, z: 1000 });
    expect(b2.yawDeg).toBeCloseTo(90, 6);
  });
  it('carries the above/below component (elevation, + = above)', () => {
    const up = bearingTo(ORIGIN, IDENTITY, { x: 0, y: 500, z: 1000 });
    expect(up.elevRad).toBeCloseTo(Math.atan2(500, 1000), 10);
    expect(up.elevRad).toBeGreaterThan(0);
    const down = bearingTo(ORIGIN, IDENTITY, { x: 0, y: -500, z: 1000 });
    expect(down.elevRad).toBeCloseTo(-Math.atan2(500, 1000), 10);
  });
  it('straight up: full elevation, straight-ahead yaw', () => {
    const b = bearingTo(ORIGIN, IDENTITY, { x: 0, y: 1000, z: 0 });
    // Zero horizontal separation is clamped to 1e-6 (degenerate branch).
    expect(b.elevRad).toBeCloseTo(Math.atan2(1000, 1e-6), 6);
    expect(b.yawDeg).toBeCloseTo(0, 10);
    expect(b.distM).toBeCloseTo(1000, 10);
  });
  it('degenerate cases (zero forward / zero horizontal) stay straight ahead', () => {
    // A vertical nose (fwd horizontal = 0) cannot produce a yaw.
    const pitch90: Quat = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }; // 90° about X: nose → -Y
    const b = bearingTo(ORIGIN, pitch90, { x: 1000, y: 0, z: 0 });
    expect(b.yawDeg).toBe(0);
    expect(b.distM).toBeCloseTo(1000, 10);
  });
});

describe('thrust vector bar + arrow lift', () => {
  it('thrust yaw follows the velocity direction (screen convention)', () => {
    expect(thrustYawDeg({ x: 0, y: 0, z: 10 }, IDENTITY)).toBeCloseTo(0, 10);
    expect(thrustYawDeg({ x: -10, y: 0, z: 0 }, IDENTITY)).toBeCloseTo(90, 6);
    expect(thrustYawDeg({ x: 0, y: 0, z: 0 }, IDENTITY)).toBe(0); // drifting up only
  });
  it('the elevation lift is clamped to the max px', () => {
    expect(elevLiftPx(Math.PI / 2, 16)).toBe(16);
    expect(elevLiftPx(-Math.PI / 2, 16)).toBe(-16);
    expect(elevLiftPx(Math.PI / 180, 16)).toBeCloseTo(1, 10); // 1° ≈ 1 px
  });
});
