import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TASK-77: the WorldManager pose-policy tests below drive the REAL manager
// (frame loop included) with a stubbed WebGLRenderer + a scripted rAF, so
// no GL context is needed.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement: unknown;
      info = { render: { calls: 0, triangles: 0 } };
      constructor(props: { canvas: unknown }) {
        this.domElement = props.canvas;
      }
      setSize(): void {}
      render(): void {}
      dispose(): void {}
    },
  };
});

import {
  WorldManager,
  buildSystemLayout,
  CAMERA_FAR,
  PAD_RING_VISIBLE_RANGE_M,
  padRingVisible,
  padRingsFor,
  STAR_COLORS,
  WORLD_BUILD_BUDGET_MS,
} from './WorldManager';
import { DOME_RADIUS_FACTOR } from '@client/render/atmosphere-dome';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { SPAWN_GATE_POS } from '@shared/galaxy/spawn';
import { padsForSystem, PAD_RADIUS_M } from '@shared/world/pads';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';

/**
 * TASK-8 world-swap layout: the pure, deterministic near-field (star,
 * first N planets, spawn gate) behind WorldManager.swapWorld. three.js is
 * never exercised here — the layout is the testable contract, and the e2e
 * asserts the measured build time stays under WORLD_BUILD_BUDGET_MS.
 */

const SEED = 'world-manager-test-seed';
const stars = generateStars(SEED, 4);
const sys0 = generateSystem(SEED, stars[0].id);
const sys1 = generateSystem(SEED, stars[1].id);

describe('buildSystemLayout (TASK-8)', () => {
  it('is deterministic: the same system always yields the same layout', () => {
    expect(buildSystemLayout(sys0)).toEqual(buildSystemLayout(sys0));
  });

  it('differs across systems (star class, id)', () => {
    const a = buildSystemLayout(sys0);
    const b = buildSystemLayout(sys1);
    expect(a.systemId).not.toBe(b.systemId);
    expect(a).not.toEqual(b);
  });

  it('carries the star class and its spectral color', () => {
    const layout = buildSystemLayout(sys0);
    expect(layout.starClass).toBe(sys0.star.class);
    expect(layout.starColor).toBe(STAR_COLORS[sys0.star.class]);
  });

  it('puts the spawn gate exactly at the shared SPAWN_GATE_POS (100 u +X)', () => {
    expect(buildSystemLayout(sys0).gate).toEqual({ ...SPAWN_GATE_POS });
    expect(WORLD_BUILD_BUDGET_MS).toBe(300);
  });

  it('no longer lays out a miniature orrery (TASK-82: the star is a distant sun)', () => {
    // The near-field planet/orbit layout is gone — the layout only carries the
    // star's identity (to tint the distant sun) and the sim-scale gate.
    const layout = buildSystemLayout(sys0);
    expect(Object.keys(layout).sort()).toEqual(['gate', 'starClass', 'starColor', 'systemId']);
    expect('planets' in layout).toBe(false);
  });
});

/**
 * TASK-29.3: pad ring markers. padRingsFor is the pure half of swapWorld's
 * pad-list presence (same deterministic list as the server, cached inside
 * the shared module); padRingVisible is the per-frame culling predicate.
 */
function fakeSystem(landable: boolean[]): Pick<SystemGen, 'systemId' | 'planets'> {
  const mk = (i: number): Planet => ({
    id: `p${i}`,
    name: `P${i}`,
    class: 'terran',
    radiusKm: 3000,
    hasAtmosphere: true,
    landable: landable[i],
    dockCount: 1,
    resourceTypes: ['iron'],
    aiRoster: { count: 1, classes: ['scout'] },
  });
  return { systemId: 'pad-ring-sys', planets: [mk(0), mk(1), mk(2)] };
}

describe('pad ring markers (TASK-29.3)', () => {
  it('padRingsFor derives one ring per pad from the SHARED pad list', () => {
    const sys = fakeSystem([true, false, true]);
    const pads = padsForSystem(SEED, sys);
    expect(pads.length).toBe(2); // one pad per LANDABLE planet
    const rings = padRingsFor(SEED, sys);
    expect(rings.length).toBe(2);
    rings.forEach((r, i) => {
      expect(r.padId).toBe(pads[i].padId);
      expect(r.x).toBe(pads[i].pos.x);
      expect(r.y).toBe(pads[i].pos.y);
      expect(r.z).toBe(pads[i].pos.z);
      expect(r.radius).toBe(pads[i].radius);
      expect(r.radius).toBe(PAD_RADIUS_M);
    });
  });

  it('is deterministic: the same (seed, system) always yields the same rings', () => {
    const sys = fakeSystem([true, false, true]);
    expect(padRingsFor(SEED, sys)).toEqual(padRingsFor(SEED, sys));
  });

  it('padRingVisible is a pure 500 m range check (3-D, inclusive)', () => {
    const pad: Vec3 = { x: 100, y: 5, z: -200 };
    expect(PAD_RING_VISIBLE_RANGE_M).toBe(500);
    expect(padRingVisible(null, pad)).toBe(false); // no position yet
    expect(padRingVisible({ ...pad }, pad)).toBe(true);
    expect(padRingVisible({ x: pad.x + PAD_RING_VISIBLE_RANGE_M, y: pad.y, z: pad.z }, pad)).toBe(
      true,
    ); // exactly 500 m: visible
    expect(
      padRingVisible({ x: pad.x + PAD_RING_VISIBLE_RANGE_M + 1, y: pad.y, z: pad.z }, pad),
    ).toBe(false); // 501 m: hidden
    // Y distance counts too (a pad 400 m below at 300 m horizontal is ~500 m out)
    expect(padRingVisible({ x: pad.x + 300, y: pad.y - 400, z: pad.z }, pad)).toBe(true);
    expect(padRingVisible({ x: pad.x + 300, y: pad.y - 401, z: pad.z }, pad)).toBe(false);
  });
});

/**
 * TASK-76 — the far-plane invariant. This is the guard that stops a future
 * change from re-introducing the "black sky inside the atmosphere" clip:
 * the dome (radius ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR) has a longest
 * chord of 2 × that radius, so the far plane must reach at least that far to
 * never clip the far wall from any point inside the dome. It must also clear
 * the 420 u sky radius the skybox is centred on (TASK-75).
 */
describe('CAMERA_FAR (TASK-76) contains the whole atmosphere dome', () => {
  it("reaches the dome's longest chord (2 × radius), so the far wall is never clipped", () => {
    const domeDiameter = 2 * ATMOSPHERE_BOUNDARY_M * DOME_RADIUS_FACTOR;
    expect(CAMERA_FAR).toBeGreaterThanOrEqual(domeDiameter);
  });

  it('comfortably exceeds the sky radius the skybox is centred on (420 u)', () => {
    expect(CAMERA_FAR).toBeGreaterThan(420);
  });
});

// ---------------------------------------------------------------------------
// TASK-77: the pose-write policy (drivePose) + the pre-render frame hook,
// exercised against the REAL WorldManager (its frame loop is driven by a
// scripted rAF; the clock is mocked so every tick advances 16 ms).

const A: import('./self-ship').SelfShipInput = {
  classId: 'scout',
  pos: { x: 0, y: 0, z: 100 },
  rot: { x: 0, y: 0, z: 0, w: 1 },
};
const B: import('./self-ship').SelfShipInput = { ...A, pos: { x: 500, y: 0, z: 100 } };
const C: import('./self-ship').SelfShipInput = { ...A, classId: 'interceptor' };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const BOOT_VANTAGE = { x: 150, y: 40, z: 150 };

function vdist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('WorldManager pose policy + pre-render hook (TASK-77)', () => {
  let rafCb: (() => void) | null = null;
  let nowMs = 1000;
  let world: WorldManager | null = null;

  beforeEach(() => {
    rafCb = null;
    nowMs = 1000;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(performance, 'now').mockImplementation(() => (nowMs += 16));
  });

  afterEach(() => {
    world?.dispose();
    world = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeWorld(): WorldManager {
    const canvas = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement;
    world = new WorldManager(canvas, SEED);
    return world;
  }

  /** Drive one full frame (the manager re-arms its rAF at the end). */
  function tick(): void {
    const cb = rafCb;
    rafCb = null;
    if (!cb) throw new Error('no frame scheduled');
    cb();
  }

  it('setSelfShip({ drivePose: false }) leaves the pose to the prediction, but a created/rebuilt mesh is placed once', () => {
    const w = makeWorld();
    w.setSelfShip(A, { drivePose: false });
    expect(w.selfShipView()!.pos).toEqual(A.pos); // created → placed once
    w.setSelfShip(B, { drivePose: false });
    expect(w.selfShipView()!.pos).toEqual(A.pos); // steady state: no pose write
    w.setSelfShip(C, { drivePose: false }); // rebuild (classId change) → placed once
    expect(w.selfShipView()!.pos).toEqual(C.pos);
    // Same hull, new pose, placement disabled: the pose stays prediction-owned.
    w.setSelfShip({ ...C, pos: B.pos }, { drivePose: false });
    expect(w.selfShipView()!.pos).toEqual(C.pos);
    w.setSelfShip(B); // default policy writes the pose
    expect(w.selfShipView()!.pos).toEqual(B.pos);
  });

  it('a drivePose:false snapshot never reaches the camera rig', () => {
    const w = makeWorld();
    w.setSelfShip(A);
    tick(); // the armed rig snaps to A's chase pose (resetPrime)
    const camA = w.cameraSample().pos;
    // Guard: the rig REALLY moved off the boot vantage (the test is not vacuous).
    expect(vdist(camA, BOOT_VANTAGE)).toBeGreaterThan(5);
    w.setSelfShip(B, { drivePose: false }); // 500 u away — must NOT feed the rig
    tick();
    tick();
    expect(vdist(w.cameraSample().pos, camA)).toBeLessThan(1); // still tracking A
  });

  it('reEnterShip({ drivePose: false }) skips the rig feed without a capsule; the default feeds it', () => {
    const w = makeWorld();
    w.setSelfShip(A);
    tick();
    const camA = w.cameraSample().pos;
    w.reEnterShip(B.pos, IDENTITY, { drivePose: false });
    tick();
    tick();
    expect(vdist(w.cameraSample().pos, camA)).toBeLessThan(1);
    w.reEnterShip(B.pos, IDENTITY); // default: the snapshot feeds the rig
    for (let i = 0; i < 6; i++) tick(); // exponential chase (k = 8/s) closes in
    expect(vdist(w.cameraSample().pos, camA)).toBeGreaterThan(5);
  });

  it('the frame hook runs at frame start, BEFORE the rig update (its pose drives the same frame)', () => {
    const w = makeWorld();
    w.setSelfShip(A);
    tick();
    const camA = w.cameraSample().pos;
    let frames = 0;
    w.setFrameHook(() => {
      frames += 1;
      // The flight step's write — the only pose writer while the predictor
      // drives (same call the 60 fps loop makes).
      w.setSelfShipTransform(B.pos, IDENTITY);
    });
    tick();
    expect(frames).toBe(1);
    // If the hook ran AFTER the rig update, this frame's camera would still
    // sit at A's chase pose — the rig must have seen B in the SAME frame.
    expect(vdist(w.cameraSample().pos, camA)).toBeGreaterThan(1);
    tick();
    expect(frames).toBe(2); // once per frame
    w.setFrameHook(null);
    tick();
    expect(frames).toBe(2); // cleared
  });

  it('the frame sampler fires once per frame; null costs nothing', () => {
    const w = makeWorld();
    let samples = 0;
    w.setFrameSampler(() => {
      samples += 1;
    });
    for (let i = 0; i < 3; i++) tick();
    expect(samples).toBe(3);
    w.setFrameSampler(null);
    tick();
    expect(samples).toBe(3);
  });
});
