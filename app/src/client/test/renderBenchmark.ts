/**
 * TASK-58: the scripted 60 s render benchmark — the project's performance
 * contract (TASK-61 re-runs it on reference hardware).
 *
 * AC-1 scene (High preset, DOM-free — the same pure-JS pipeline the
 * transitionCycle harness drives, no WebGL needed):
 *   - 16 ships in combat (8 players 'ship' + 8 AI 'ai-ship') on circular
 *     orbits around the player, lasers at rate + a 16-strong in-flight
 *     missile set + a ship destruction every 3 s (the explosion set);
 *   - the player on a surface with the full 13-chunk streaming scene
 *     (near 3x3 + the mid/far rings — warmed up before measurement). The
 *     scene holds the STEADY at-rest active window (13 chunks); the live
 *     pipeline's far-ring horizon impostors are outside the AC-1 spec, so
 *     the driver streamer filters them out of the mountable set;
 *   - the system's hazard cells (buildHazardDiscs) + 4 hostile drones;
 *   - 30 deposits inside the 500 m render ring (OreRockLayer);
 *   - 20+ remote callsign labels (the RemoteEntityLayer's overlay math).
 *
 * Every simulated frame (60 Hz) runs the live loop's per-frame stages in
 * the live order and WALL-times them (main-thread work a frame must pay):
 * remote feed (10 Hz) → FX frame → remote renderFrame (labels) → chunk
 * scene sync + streamer → ore-rock ring → starfield drift → a scene-graph
 * tally (draw calls = visible mesh/line/points, triangles, distinct
 * materials). The tally is the headless stand-in for renderer.info — the
 * numbers are a proxy (AC-2: the ≥ 30 % worst-case delta is the
 * machine-independent success; absolute fps is TASK-61's).
 *
 * Paced to REAL time (60 s of sim = 60 s of wall by default,
 * `paceToRealTime`): frame times then measure actual main-thread work, and
 * the FX layer's real-time slow-mo window (performance.now) stays
 * proportional to the simulated combat — an unpaced run fired every 3 s of
 * SIM in 50 ms of REAL, so the 1 s slow-mo never expired and the debris
 * tail sat in the scene for the whole run.
 *
 * The tally is FRUSTUM-culled like the renderer (three.js frustum-culls
 * every mesh/line/points object per frame; renderer.info counts what was
 * actually drawn, not what is in the scene graph).
 *
 * `tuned: true` (default) runs the TASK-58 pipeline (merged ships,
 * instanced ore, the FX material pool, the profile's FX caps);
 * `tuned: false` is the PRE-tuning baseline (legacy 7-mesh ships, per-rock
 * ore meshes, uncapped FX) — `npm run bench:render` runs both and reports
 * the delta.
 */

import * as THREE from 'three';

import { generateSystem } from '@shared/galaxy/system';
import type { Vec3 } from '@shared/physics/vec';
import { padsForSystem } from '@shared/world/pads';
import { Rng, seedFromString } from '@shared/random';
import { PERF_PROFILES, type FxCaps } from '@shared/perf';
import type { EntityState, Livery } from '@shared/protocol/schemas';
import { ChunkStreamer, activeSet, chunkKey, type CachedChunk } from '@client/world/chunks';
import { ChunkScene } from '@client/world/chunk-scene';
import { OreRockLayer } from '@client/world/ore-rocks';
import { CombatFx } from '@client/world/combat-fx';
import { RemoteEntityLayer, type Projected } from '@client/world/remote-entities';
import { buildHazardDiscs } from '@client/world/hazard-discs';
import { createBackground } from '@client/render/starfield';
import { FrameMonitor, type FrameStats } from '@client/perf/frameMonitor';
import devSeed from '@shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json';

/** The simulated render rate (the reference client profile: 60 Hz). */
export const BENCH_FRAME_HZ = 60;
/** AC-1: the 60 s benchmark at 60 Hz. */
export const BENCH_DEFAULT_FRAMES = 60 * BENCH_FRAME_HZ;
/** The no-spike rule's threshold (ms — zero frames over it). */
export const BENCH_SPIKE_MS = 50;
/** AC-1: the AC-1 scene's deposit count inside the 500 m ring. */
export const BENCH_DEPOSIT_COUNT = 30;
/** The full streaming scene (AC-1 "13-chunk streaming"). */
export const BENCH_MOUNT_TARGET = 13;
/** Ships on orbit (8 player + 8 AI). */
const SHIP_COUNT = 16;
/** The 16-strong in-flight missile set (the shard's budget). */
const MISSILE_COUNT = 16;
/** One ship destruction every N frames (3 s). */
const EXPLOSION_EVERY_FRAMES = 180;
/** Laser cadence: one shot every N frames per ship (~2 shots/s). */
const LASER_EVERY_FRAMES = 48;
/** The 4 hostile surface drones in the hazard cells. */
const DRONE_COUNT = 4;
/** Orbital radius / altitude / angular speed (m, m, rad/s). */
const ORBIT_RADIUS_M = 450;
const ORBIT_ALT_M = 300;
const ORBIT_SPEED = 60;

const RESOURCES = ['iron', 'copper', 'rare-earth', 'crystal'] as const;
const LIVERIES: Livery[] = [
  { hull: '#2f6f6a', accent: '#7dd3fc', trim: '#e2e8f0' },
  { hull: '#7c5cbf', accent: '#f472b6', trim: '#fde68a' },
  { hull: '#3f6212', accent: '#a3e635', trim: '#d9f99d' },
  { hull: '#7f1d1d', accent: '#fb923c', trim: '#fecaca' },
  { hull: '#1e3a8a', accent: '#60a5fa', trim: '#bfdbfe' },
  { hull: '#44403c', accent: '#f59e0b', trim: '#fde68a' },
  { hull: '#831843', accent: '#f9a8d4', trim: '#fce7f3' },
  { hull: '#134e4a', accent: '#2dd4bf', trim: '#99f6e4' },
];

export interface RenderBenchmarkOptions {
  /** Simulated frames (default 3600 = 60 s). The CI version uses 600 (10 s). */
  frames?: number;
  /** false = the pre-tuning baseline (legacy ships/ore, uncapped FX). */
  tuned?: boolean;
  seed?: string;
  starId?: string;
  planetIndex?: number;
  /** Monitor to feed (default: a fresh FrameMonitor per run). */
  monitor?: FrameMonitor;
  /** Wall-clock cap (fail fast, default 180 s). */
  wallTimeoutMs?: number;
  /**
   * Pace the loop to real time (default true — 60 s of sim = 60 s of wall).
   * Required for the FX slow-mo window (real-time) to stay proportional to
   * the simulated combat and for the frame times to measure actual work.
   */
  paceToRealTime?: boolean;
  /** AC1-style per-frame hook (optional). */
  onFrame?: (frameIndex: number, stats: FrameStats) => void;
}

/** One run's report (the numbers recorded for TASK-61). */
export interface RenderBenchmarkReport {
  tuned: boolean;
  frames: number;
  /** Frame-time percentiles (ms) over the whole run. */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** AC-2 no-spike rule: frames STRICTLY over BENCH_SPIKE_MS. */
  spikes50Ms: number;
  /** The scene-graph tally (renderer.info stand-in), per-frame extrema. */
  drawCallsMax: number;
  drawCallsP95: number;
  materialsMax: number;
  trianglesMax: number;
  /** The FX caps held (observed maxes — the registry's enforcement). */
  maxLaserFlashes: number;
  maxDebrisSets: number;
  maxMissiles: number;
  /** Per-stage wall ms of the WHOLE run (where the frame time went). */
  stageMs: {
    remoteFeedMs: number;
    fxMs: number;
    remoteRenderMs: number;
    surfaceMs: number;
    oreMs: number;
    tallyMs: number;
  };
  /** Wall ms the run took on this machine. */
  wallMs: number;
}

interface OrbitShip {
  id: string;
  kind: 'ship' | 'ai-ship';
  callsign: string;
  livery: Livery | undefined;
  phase: number;
}

function shipEntity(s: OrbitShip, simMs: number): EntityState {
  const t = simMs / 1000;
  const ang = s.phase + (t * ORBIT_SPEED) / ORBIT_RADIUS_M;
  const pos = {
    x: Math.cos(ang) * ORBIT_RADIUS_M,
    y: ORBIT_ALT_M,
    z: Math.sin(ang) * ORBIT_RADIUS_M,
  };
  // Velocity = tangent to the orbit (speed ORBIT_SPEED).
  const vel = { x: -Math.sin(ang) * ORBIT_SPEED, y: 0, z: Math.cos(ang) * ORBIT_SPEED };
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(vel.x, 0, vel.z),
    new THREE.Vector3(0, 1, 0),
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return {
    id: s.id,
    kind: s.kind,
    pos,
    vel,
    rot: { x: q.x, y: q.y, z: q.z, w: q.w },
    regime: 'cruise',
    hull: 1,
    shields: 1,
    targetId: null,
    classId: 'scout',
    callsign: s.callsign,
    livery: s.livery,
  } as EntityState;
}

/**
 * AC-1 measures the STEADY 13-chunk streaming state (the at-rest active
 * set: 3x3 near + the four cardinal mid/far chunks). The live pipeline also
 * mounts the far-ring horizon impostors around that window; the benchmark
 * scene spec is the 13 active chunks, so this driver-only streamer filters
 * the mountable set back to the active window. It reuses the base class's
 * `mountable()` (which stamps `lastAccessFrame` so the LRU never evicts a
 * mounted chunk) and then drops the horizon entries — no scene or pipeline
 * change, just the documented AC-1 steady state.
 */
class Ac1Streamer extends ChunkStreamer {
  override mountable(
    playerX: number,
    playerZ: number,
    speed: number,
  ): Array<{ entry: CachedChunk; ring: 'near' | 'mid' | 'far' }> {
    const active = new Set(
      activeSet(playerX, playerZ, speed).map((a) => chunkKey(a.chunkX, a.chunkZ)),
    );
    return super.mountable(playerX, playerZ, speed).filter((w) => active.has(w.entry.key));
  }
}

/**
 * Run the benchmark once and return the report. Throws when the fixture
 * cannot support the scene or the wall budget is exceeded.
 */
export function runRenderBenchmark(options: RenderBenchmarkOptions = {}): RenderBenchmarkReport {
  const seed = options.seed ?? devSeed.seed;
  const starId = options.starId ?? devSeed.starId;
  const planetIndex = options.planetIndex ?? devSeed.planetIndex;
  const frames = options.frames ?? BENCH_DEFAULT_FRAMES;
  const tuned = options.tuned ?? true;
  const monitor = options.monitor ?? new FrameMonitor();
  const wallTimeoutMs = options.wallTimeoutMs ?? 180_000;
  const profile = PERF_PROFILES.high;
  const caps: FxCaps = tuned
    ? profile.fxCaps
    : { laserFlashes: 9999, missiles: 16, debrisSets: 9999 };
  const wallStart = performance.now();

  const system = generateSystem(seed, starId);
  const planet = system.planets[planetIndex];
  if (!planet) throw new Error('TASK-58: fixture planet missing');
  const pad =
    padsForSystem(seed, system).find((p) => p.planetId === planet.id) ??
    padsForSystem(seed, system)[0];
  if (!pad) throw new Error('TASK-58: fixture system has no landing pad');
  // The player stands on the pad (the local space the streaming pipeline uses).
  const playerPos: Vec3 = { x: pad.pos.x, y: pad.pos.y, z: pad.pos.z };

  const threeScene = new THREE.Scene();
  const systemGroup = new THREE.Group();
  threeScene.add(systemGroup);
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 20_000);
  camera.position.set(playerPos.x, playerPos.y + 2.4, playerPos.z + 1);
  camera.lookAt(playerPos.x, playerPos.y + 2, playerPos.z - 50);

  // The full streaming scene (warmed up BEFORE measurement — the AC-1 scene
  // is the STEADY 13-chunk state, not the cold-load burst). The driver
  // streamer caps the mountable set to that 13-chunk active window (the
  // live pipeline's far-ring horizon is outside the AC-1 scene spec).
  const streamer = new Ac1Streamer(seed, planet);
  const chunkScene = new ChunkScene(streamer, { monitor });
  threeScene.add(chunkScene.group);
  for (let i = 0; i < 4000 && chunkScene.mountedCount < BENCH_MOUNT_TARGET; i++) {
    streamer.update(playerPos.x, playerPos.z, 0);
    chunkScene.sync(playerPos.x, playerPos.z, 0);
  }
  if (chunkScene.mountedCount < BENCH_MOUNT_TARGET) {
    throw new Error(
      `TASK-58: only ${chunkScene.mountedCount}/${BENCH_MOUNT_TARGET} chunks mounted in the warm-up`,
    );
  }

  // Background: the preset's star count (one Points cloud + the sky dome).
  const background = createBackground(seed, profile.starCount);
  threeScene.add(background.sky);
  threeScene.add(background.stars);

  // Hazard cells + the AC-1's 30 deposits in the 500 m ring (synthetic,
  // deterministic — the layer renders them like seeded rocks).
  const hazard = buildHazardDiscs(seed, system);
  for (const disc of hazard) systemGroup.add(disc.group);
  const deposits = Array.from({ length: BENCH_DEPOSIT_COUNT }, (_, i) => {
    const ang = (i / BENCH_DEPOSIT_COUNT) * Math.PI * 2;
    const r = 60 + (i % 10) * 40; // 60-460 m out, inside the ring
    return {
      depositId: `${planet.id}:${i}`,
      depositSeq: i,
      planetId: planet.id,
      pos: {
        x: playerPos.x + Math.cos(ang) * r,
        y: playerPos.y,
        z: playerPos.z + Math.sin(ang) * r,
      },
      resourceId: RESOURCES[i % RESOURCES.length],
      amount: 20,
      discovered: true,
    };
  });
  const oreLayer = new OreRockLayer({ instanced: tuned });
  oreLayer.attach(threeScene);
  oreLayer.setDeposits(deposits);

  // Combat FX (the registry enforces the caps; baseline runs uncapped).
  const combatFx = new CombatFx((g) => {
    threeScene.add(g);
    return camera;
  });
  combatFx.setFxCaps(caps);

  // The 16 remote ships on orbit (8 player livery + 8 AI hostile).
  const remotes = new RemoteEntityLayer();
  remotes.setParent(systemGroup);
  const width = 1280;
  const height = 720;
  remotes.setProjector((pos): Projected | null => {
    camera.updateMatrixWorld();
    const v = new THREE.Vector3(pos.x, pos.y + 2, pos.z).project(camera);
    if (v.z > 1) return null;
    return {
      x: ((v.x + 1) / 2) * width,
      y: ((1 - v.y) / 2) * height,
      dist: camera.position.distanceTo(new THREE.Vector3(pos.x, pos.y, pos.z)),
    };
  });
  const ships: OrbitShip[] = Array.from({ length: SHIP_COUNT }, (_, i) => ({
    id: `ship-${i}`,
    kind: i < 8 ? 'ship' : 'ai-ship',
    callsign: i < 8 ? `benchpilot${i}` : `rogue-${i - 8}`,
    livery: i < 8 ? LIVERIES[i] : undefined,
    phase: (i / SHIP_COUNT) * Math.PI * 2,
  }));
  // 4 hostile drones hovering in the hazard cells.
  const droneIds = Array.from({ length: DRONE_COUNT }, (_, i) => `drone-${i}`);

  // The 16 in-flight missiles (10 Hz updates along their own orbit).
  interface Missile {
    id: string;
    phase: number;
    bornFrame: number;
  }
  let missiles: Missile[] = [];
  // Deterministic spawn phases (a benchmark must not use Math.random).
  const missileRng = new Rng(seedFromString(`${seed}:${starId}:missiles`));
  const missileAt = (m: Missile, frame: number): { pos: Vec3; vel: Vec3 } => {
    const ang = m.phase + ((frame - m.bornFrame) / BENCH_FRAME_HZ) * 0.25;
    const r = 200 + ((frame - m.bornFrame) / BENCH_FRAME_HZ) * 25;
    return {
      pos: { x: Math.cos(ang) * r, y: 150, z: Math.sin(ang) * r },
      vel: { x: -Math.sin(ang) * 25, y: 0, z: Math.cos(ang) * 25 },
    };
  };

  let simMs = 0;
  const stageMs = {
    remoteFeedMs: 0,
    fxMs: 0,
    remoteRenderMs: 0,
    surfaceMs: 0,
    oreMs: 0,
    tallyMs: 0,
  };
  const drawCallsPerFrame: number[] = [];
  let tallyTriangles: number;
  let materialsMax = 0;
  let trianglesMax = 0;
  let maxLaserFlashes = 0;
  let maxDebrisSets = 0;
  let maxMissiles = 0;
  let frameIndex = 0;

  // The renderer draws only what is inside the camera frustum (three.js
  // frustum-culls every mesh/line/points object before dispatch), so the
  // renderer.info stand-in tallies the SAME set — the scene-graph total
  // would over-count everything behind the camera (the far-ring horizon).
  const tallyFrustum = new THREE.Frustum();
  const tallyProj = new THREE.Matrix4();
  const tallySphere = new THREE.Sphere();
  const inTallyFrustum = (obj: THREE.Object3D): boolean => {
    const g = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || g.boundingSphere === null) return true;
    tallySphere.copy(g.boundingSphere).applyMatrix4(obj.matrixWorld);
    return tallyFrustum.intersectsSphere(tallySphere);
  };

  const tallyScene = (): { calls: number; triangles: number; materials: number } => {
    // The renderer does this before every dispatch (world matrices + frustum).
    threeScene.updateMatrixWorld();
    camera.updateMatrixWorld();
    tallyProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    tallyFrustum.setFromProjectionMatrix(tallyProj);

    let calls = 0;
    let triangles = 0;
    const materials = new Set<THREE.Material>();
    const tri = (g: THREE.BufferGeometry): number =>
      g.getIndex() ? g.index!.count / 3 : (g.getAttribute('position')?.count ?? 0);
    const visit = (obj: THREE.Object3D): void => {
      if (!obj.visible) return;
      const mesh = obj as THREE.Mesh;
      const points = (obj as THREE.Points).isPoints;
      const line = (obj as THREE.Line).isLine;
      if ((points || line || mesh.isMesh) && (obj.frustumCulled === false || inTallyFrustum(obj))) {
        calls += 1;
        const g = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g && !points && !line) triangles += tri(g);
        const m = (obj as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => materials.add(x));
        else if (m) materials.add(m);
      }
      for (const child of obj.children) visit(child);
    };
    visit(threeScene);
    return { calls, triangles, materials: materials.size };
  };

  // Pacing: frame N starts at loopStart + N/60 s (no faster than 60 Hz; a
  // spike just delays the next frame — the run lengthens, it never
  // compresses sim). The sleep is OUTSIDE the begin/end frame window, so
  // the measured frame time stays the main-thread work of the frame.
  const paceToRealTime = options.paceToRealTime ?? true;
  const frameWallMs = 1000 / BENCH_FRAME_HZ;
  const loopStart = performance.now();

  try {
    for (frameIndex = 0; frameIndex < frames; frameIndex++) {
      if (paceToRealTime) sleepUntil(loopStart + frameIndex * frameWallMs);
      simMs = frameIndex * (1000 / BENCH_FRAME_HZ);
      monitor.beginFrame();

      // ---- 1. remote feed (10 Hz): ships + drones + the missile set ----
      if (frameIndex % 6 === 0) {
        const t = performance.now();
        const entities: EntityState[] = ships.map((s) => shipEntity(s, simMs));
        for (const id of droneIds) {
          const i = Number(id.split('-')[1]);
          const ang = (i / DRONE_COUNT) * Math.PI * 2 + (simMs / 1000) * 0.1;
          entities.push({
            id,
            kind: 'drone',
            pos: {
              x: playerPos.x + Math.cos(ang) * 120,
              y: playerPos.y + 8,
              z: playerPos.z + Math.sin(ang) * 120,
            },
            vel: { x: 0, y: 0, z: 0 },
            regime: 'cruise',
            hull: 1,
            shields: 0,
            targetId: null,
            classId: 'drone',
            callsign: undefined,
          } as EntityState);
        }
        // Missile bookkeeping: spawn to keep 16 in flight, retire the oldest
        // after 4 s.
        if (missiles.length < MISSILE_COUNT) {
          missiles.push({
            id: `m-${frameIndex}-${missiles.length}`,
            phase: missileRng.nextRange(0, Math.PI * 2),
            bornFrame: frameIndex,
          });
        }
        missiles = missiles.filter((m) => frameIndex - m.bornFrame <= 240);
        for (const m of missiles) {
          const { pos, vel } = missileAt(m, frameIndex);
          entities.push({
            id: m.id,
            kind: 'projectile',
            pos,
            vel,
            regime: 'cruise',
            hull: 1,
            shields: 0,
            targetId: null,
            classId: 'bolt',
          } as EntityState);
        }
        remotes.addSnapshot(simMs, entities, 'self');
        // The registry's tracer pool (capped) + the laser cadence + the
        // 3 s destruction. Lasers fire nose→nearest-ship (positions only).
        combatFx.updateProjectiles(entities);
        if (frameIndex % LASER_EVERY_FRAMES === 0) {
          const f = ships[(frameIndex / LASER_EVERY_FRAMES) % SHIP_COUNT];
          const to = ships[(frameIndex + 5) % SHIP_COUNT];
          const from = shipEntity(f, simMs).pos;
          const toPos = shipEntity(to, simMs).pos;
          combatFx.addLaserFlash(from, toPos);
          if (frameIndex % 2 === 0) combatFx.addImpactFlash(toPos);
        }
        if (frameIndex % EXPLOSION_EVERY_FRAMES === 0 && frameIndex > 0) {
          const victim = ships[(frameIndex / EXPLOSION_EVERY_FRAMES) % SHIP_COUNT];
          combatFx.addExplosion(shipEntity(victim, simMs).pos);
        }
        stageMs.remoteFeedMs += performance.now() - t;
      }

      // ---- 2. combat FX: age the effects ----
      {
        const t = performance.now();
        combatFx.frame(simMs);
        stageMs.fxMs += performance.now() - t;
      }

      // ---- 3. remote render (interpolation + labels) ----
      {
        const t = performance.now();
        remotes.renderFrame(simMs);
        stageMs.remoteRenderMs += performance.now() - t;
      }

      // ---- 4. surface pipeline: streamer slice + chunk scene sync ----
      {
        const t = performance.now();
        streamer.update(playerPos.x, playerPos.z, 0);
        chunkScene.sync(playerPos.x, playerPos.z, 0);
        stageMs.surfaceMs += performance.now() - t;
      }

      // ---- 5. ore-rock 500 m ring + pulse ----
      {
        const t = performance.now();
        oreLayer.update(playerPos, simMs);
        stageMs.oreMs += performance.now() - t;
      }

      // ---- 6. starfield drift ----
      background.stars.rotation.y = (simMs / 1000) * 0.005;

      // ---- 7. the scene-graph tally (renderer.info stand-in) ----
      {
        const t = performance.now();
        const tally = tallyScene();
        tallyTriangles = tally.triangles;
        drawCallsPerFrame.push(tally.calls);
        materialsMax = Math.max(materialsMax, tally.materials);
        trianglesMax = Math.max(trianglesMax, tally.triangles);
        stageMs.tallyMs += performance.now() - t;
        maxLaserFlashes = Math.max(maxLaserFlashes, combatFx.laserFlashCount);
        maxDebrisSets = Math.max(maxDebrisSets, combatFx.debrisSetCount);
        maxMissiles = Math.max(maxMissiles, combatFx.activeCount);
      }

      monitor.endFrame(
        {
          drawCalls: drawCallsPerFrame[drawCallsPerFrame.length - 1],
          triangles: tallyTriangles,
        },
        performance.now(),
      );
      options.onFrame?.(frameIndex, monitor.getFrameStats());

      if (frameIndex % 120 === 119 && performance.now() - wallStart > wallTimeoutMs) {
        throw new Error(
          `TASK-58: benchmark exceeded the ${wallTimeoutMs} ms wall budget at frame ${frameIndex}`,
        );
      }
    }
  } finally {
    oreLayer.dispose();
    background.dispose();
    chunkScene.dispose();
    streamer.reset();
    remotes.clear();
  }

  const stats = monitor.getFrameStats();
  const p95 = (arr: number[], p: number): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  };
  return {
    tuned,
    frames,
    p50Ms: round3(stats.frameTimeP50Ms),
    p95Ms: round3(stats.frameTimeP95Ms),
    p99Ms: round3(stats.frameTimeP99Ms),
    maxMs: round3(stats.maxFrameMs),
    spikes50Ms: monitor.frameSpikes(BENCH_SPIKE_MS),
    drawCallsMax: Math.max(0, ...drawCallsPerFrame),
    drawCallsP95: p95(drawCallsPerFrame, 95),
    materialsMax,
    trianglesMax,
    maxLaserFlashes,
    maxDebrisSets,
    maxMissiles,
    stageMs: {
      remoteFeedMs: round3(stageMs.remoteFeedMs),
      fxMs: round3(stageMs.fxMs),
      remoteRenderMs: round3(stageMs.remoteRenderMs),
      surfaceMs: round3(stageMs.surfaceMs),
      oreMs: round3(stageMs.oreMs),
      tallyMs: round3(stageMs.tallyMs),
    },
    wallMs: Math.round(performance.now() - wallStart),
  };
}

function round3(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/**
 * Synchronous sleep until a performance.now() deadline (the driver is a
 * synchronous API — Atomics.wait blocks the bench thread without burning
 * a core; spurious early wakes are re-checked against the deadline).
 */
const paceSlot = new Int32Array(new SharedArrayBuffer(4));
function sleepUntil(deadlineMs: number): void {
  for (;;) {
    const remaining = deadlineMs - performance.now();
    if (remaining <= 0) return;
    Atomics.wait(paceSlot, 0, 0, remaining);
  }
}
