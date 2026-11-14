import { describe, expect, it } from 'vitest';
import { listSpawnSystems } from '@shared/galaxy/spawn.ts';
import { surfaceFrameId, surfaceToSystem } from '@shared/physics/frames.ts';
import { distance } from '@shared/physics/vec.ts';
import { chaseCameraPosition, relativeTo } from '../render/relative.ts';
import {
  EntityStore,
  INTERPOLATION_DELAY_MS,
  nlerp,
  systemPose,
  type EntityState,
} from './entityStore.ts';
import { deriveSystem } from './systemData.ts';

const SEED = 'drift-dev-seed-001';
const HOME = listSpawnSystems(SEED)[0]!.systemId;

const entity = (id: string, x: number, over: Partial<EntityState> = {}): EntityState => ({
  id,
  kind: 'ship',
  pos: { frame: 'system', x, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  regime: 'space',
  hull: 100,
  shields: 50,
  targetId: null,
  classId: 'scout',
  ...over,
});
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

describe('deriveSystem', () => {
  it('regenerates a system from the seed and rejects foreign ids', () => {
    const { system, bodies } = deriveSystem(SEED, HOME);
    expect(system.systemId).toBe(HOME);
    expect(bodies[0]!.kind).toBe('star');
    expect(bodies).toHaveLength(system.planets.length + 1);
    expect(() => deriveSystem(SEED, 'ffffffffffffffff')).toThrow(RangeError);
  });
});

describe('camera-relative math', () => {
  it('keeps sub-millimetre precision 1e8 m from the star', () => {
    const camera = { x: 1.23456789e8, y: -4.5e7, z: 9.87654321e7 };
    const ship = { x: camera.x + 12.345, y: camera.y - 0.001, z: camera.z + 7 };
    const relative = relativeTo(ship, camera);
    expect(relative.x).toBeCloseTo(12.345, 6);
    expect(relative.y).toBeCloseTo(-0.001, 6);
    expect(relative.z).toBeCloseTo(7, 6);
    // The same offset survives a float32 round trip, which the raw world position would not.
    expect(Math.abs(Math.fround(relative.x) - 12.345)).toBeLessThan(1e-5);
    expect(Math.abs(Math.fround(ship.x) - ship.x)).toBeGreaterThan(1);
  });

  it('puts the chase camera behind and above the ship in the ship own axes', () => {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    expect(chaseCameraPosition({ x: 10, y: 0, z: 0 }, identity, { x: 0, y: 7, z: 26 })).toEqual({
      x: 10,
      y: 7,
      z: 26,
    });
    const yawLeft90 = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; // nose now along -x
    const p = chaseCameraPosition({ x: 0, y: 0, z: 0 }, yawLeft90, { x: 0, y: 0, z: 26 });
    expect(p.x).toBeCloseTo(26, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });
});

describe('EntityStore', () => {
  const { bodies } = deriveSystem(SEED, HOME);

  it('tracks, updates and removes entities with the server set', () => {
    const store = new EntityStore(bodies);
    store.apply([entity(A, 0), entity(B, 5)], 1000);
    expect(store.ids().sort()).toEqual([A, B]);
    store.apply([entity(A, 10)], 1100);
    expect(store.ids()).toEqual([A]);
    expect(store.size).toBe(1);
    expect(store.state(A)!.pos.x).toBe(10);
    expect(store.state(B)).toBeUndefined();
    expect(store.poseAt(B, 1100)).toBeUndefined();
  });

  it('renders 100 ms in the past, blending the two latest samples without extrapolating', () => {
    const store = new EntityStore(bodies);
    store.apply([entity(A, 0)], 1000);
    expect(store.poseAt(A, 5000)!.pos.x).toBe(0); // a single sample is held
    store.apply([entity(A, 10)], 1100);
    const at = (now: number) => store.poseAt(A, now)!.pos.x;
    expect(at(1100)).toBe(0); // render time 1000 = the previous sample
    expect(at(1100 + INTERPOLATION_DELAY_MS / 2)).toBeCloseTo(5, 9);
    expect(at(1100 + INTERPOLATION_DELAY_MS)).toBeCloseTo(10, 9);
    expect(at(9999)).toBe(10); // never past the latest sample
    let previous = -1;
    for (let now = 1100; now <= 1200; now += 4) {
      expect(at(now)).toBeGreaterThanOrEqual(previous); // monotonic: no jumps back
      previous = at(now);
    }
  });

  it('expresses surface-frame entities in the system frame, on the planet', () => {
    const planet = bodies.find((body) => body.hasSurfaceFrame)!;
    const flat = { x: 1200, y: 350, z: -800 };
    const state = entity(A, 0, {
      pos: { frame: surfaceFrameId(planet.id, 's'), ...flat },
      regime: 'atmosphere',
    });
    const pose = systemPose(state, bodies);
    expect(distance(pose.pos, surfaceToSystem(planet, 's', flat))).toBeLessThan(1e-6);
    expect(distance(pose.pos, planet.center)).toBeCloseTo(planet.radius + 350, 3);
  });

  it('blends orientations along the shorter arc and stays unit length', () => {
    const a = { x: 0, y: 0, z: 0, w: 1 };
    const b = { x: 0, y: -Math.SQRT1_2, z: 0, w: -Math.SQRT1_2 }; // same rotation as +90 yaw
    const mid = nlerp(a, b, 0.5);
    expect(Math.hypot(mid.x, mid.y, mid.z, mid.w)).toBeCloseTo(1, 12);
    expect(mid.y).toBeGreaterThan(0.3); // went the short way (45 degrees), not through 135
  });
});
