/**
 * TASK-30: scripted transition-cycle benchmark harness (dev-only).
 *
 * Drives the client's REAL per-frame pipeline through the full seamless
 * transition cycle — space → atmosphere → surface on pad → disembark →
 * walk 10 m → re-enter → atmosphere → space — and verifies the core
 * promise: every transition adds < 4 ms of frame time (DELTA vs the same
 * scene without the transition), with no frame > 100 ms (no GC spikes, no
 * chunk stalls) on the reference client profile.
 *
 * How it runs. The harness is DOM-free (three.js geometry/math is pure JS —
 * only a WebGLRenderer would need GL, and there is none), so the same code
 * runs headless in Node (`npm run bench:transitions`, the CI test in
 * transitionCycle.test.ts) and in the page (`window.__TRANSITION__`,
 * dev-only). One simulated frame = 60 Hz; each frame runs the live loop's
 * per-frame stages in the live loop's order, and the WALL ms of each stage
 * is the frame-time sample (main-thread work a frame must pay):
 *
 *   1. atmosphere  — regimeFor + atmosphereViewFor + dome.set + sky fade
 *                    (WorldManager.setAtmosphereView + pad-ring cull)
 *   2. streamer    — ChunkStreamer.update (the 4 ms/frame slice contract)
 *   3. scene       — ChunkScene.sync (mount / LOD-pointer swap / unmount)
 *   4. camera      — CameraRig.update (+ handoff trigger / pose feeds)
 *   5. one-shot    — the transition's one-time work (character mesh
 *                    build/dispose, livery material swap, streamer boot/
 *                    shutdown, handoff path precompute)
 *
 * The ship's flight path is a synthetic position timeline — the client-side
 * equivalent of the /api/dev/teleport hard-sets the e2e suite uses (the
 * TASK-27 rig is driven standalone, exactly as camera-debug's
 * handoffProbe scripts it), so no real player, server or network is needed.
 *
 * Delta methodology (AC2). Every frame is attributed to a phase; transition
 * frames are TAGGED (regime flip ±2, the 600 ms handoff window, chunk
 * boundary + burst-drain after each new chunk enters the active set,
 * streamer boot/shutdown, character build/dispose, material swaps). A
 * phase's baseline is the p50 of its own STEADY (untagged) frames — "the
 * same scene without the transition" — falling back to the 3 s idle
 * baseline of the phase's scene class when the phase has no steady frames
 * (the handoff phases). The budget check (via the TASK-57 FrameMonitor)
 * runs on the p99 of the tagged frames' deltas, so a single GC spike is not
 * mistaken for the transition (the raw max is still reported, and the
 * no-pull check is on the raw max of EVERY frame).
 *
 * Pre-generation check (step 3): the descent runs at 120 m/s ≥
 * FAST_TRAVEL_SPEED, so the streamer's 7x7 fast ring is active from the
 * boundary crossing; the harness records whether the pad's 3x3 near block
 * is ready BEFORE pad arrival (it must be — that is what keeps the arrival
 * frame spike-free).
 *
 * Only installed on `window.__TRANSITION__` when `import.meta.env.DEV` —
 * never ships in a production build.
 */

import * as THREE from 'three';

import { generateSystem } from '@shared/galaxy/system';
import {
  planetAnchor,
  planetAtmosphereDensity,
  planetAtmosphereRadius,
  systemRegimePlanets,
} from '@shared/galaxy/planets';
import { regimeFor, type Regime } from '@shared/regime';
import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import type { Vec3 } from '@shared/physics/vec';
import { padsForSystem } from '@shared/world/pads';
import { chunkOfMeters, chunkKey, ChunkStreamer } from '@client/world/chunks';
import { ChunkScene } from '@client/world/chunk-scene';
import { ATMOSPHERE_HAZE_COLORS, createAtmosphereDome } from '@client/render/atmosphere-dome';
import { atmosphereViewFor } from '@client/world/atmosphere-view';
import { FrameMonitor, type FrameStats } from '@client/perf/frameMonitor';
import { CameraRig } from '@client/camera/CameraRig';
import { buildCharacterMesh } from '@client/world/WorldManager';
import devSeed from '@shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json';

/** AC2: a transition may add at most this much (ms) above the baseline. */
export const TRANSITION_BUDGET_MS = 4;
/** AC3: no frame anywhere in the cycle may exceed this (no-pull check). */
export const NO_PULL_MAX_MS = 100;
/** The simulated render rate (the reference client profile: 60 Hz). */
export const FRAME_HZ = 60;

const DT_S = 1 / FRAME_HZ;
/** AC2: 3 s of idle per scene class establishes the idle baseline. */
export const IDLE_FRAMES = 3 * FRAME_HZ;
/** Frames of the 600 ms TASK-27 handoff window at 60 Hz. */
const HANDOFF_FRAMES = 36;
/** Burst-drain window after a chunk-boundary frame (backlog settles). */
const BURST_DRAIN_FRAMES = 24;

// Flight-path altitudes (m above the pad plane) and speeds (m/s).
const START_ALT_M = 1_600; // comfortably beyond the exit radius (1050)
const MID_ALT_M = 500; // steady-atmosphere cruise altitude
const VTOL_START_ALT_M = 40; // VTOL deceleration begins here
const PAD_ALT_M = 1; // pad surface (docked altitude)
const SPACE_SPEED = 150;
/** Descent/ascent speed: ≥ FAST_TRAVEL_SPEED (100) → 7x7 pre-gen ring. */
const SURFACE_SPEED = 120;
/** = SURFACE_SPEED_LIMIT_M_S (5): slow enough to be surface-eligible. */
const VTOL_SPEED = 5;
const WALK_SPEED = 3;
/** Horizontal streamer travel of the descent (460 m fast + 39 m VTOL). */
const STREAM_TRAVEL_M = (MID_ALT_M - VTOL_START_ALT_M) + (VTOL_START_ALT_M - PAD_ALT_M);

/** The 8 AC transition phases, in cycle order (idle phases are baselines). */
export type TransitionPhase =
  | 'space-to-atmosphere'
  | 'atmosphere-to-surface'
  | 'disembark'
  | 'walk-10m'
  | 're-enter'
  | 'surface-to-atmosphere'
  | 'atmosphere-to-space';

/** A transition phase, an idle baseline phase, or the streaming control. */
export type PhaseName =
  | TransitionPhase
  | 'idle-space'
  | 'idle-atmosphere'
  | 'idle-surface'
  | 'steady-streaming-control';

export const CYCLE_PHASES: PhaseName[] = [
  'idle-space',
  'space-to-atmosphere',
  'idle-atmosphere',
  'steady-streaming-control',
  'atmosphere-to-surface',
  'idle-surface',
  'disembark',
  'walk-10m',
  're-enter',
  'surface-to-atmosphere',
  'atmosphere-to-space',
];

/** The 7 AC transitions (idle phases are baseline sources, not budgeted). */
export const TRANSITION_PHASES: TransitionPhase[] = [
  'space-to-atmosphere',
  'atmosphere-to-surface',
  'disembark',
  'walk-10m',
  're-enter',
  'surface-to-atmosphere',
  'atmosphere-to-space',
];

/** Scene class a phase's frames belong to (idle-baseline fallback key). */
const PHASE_SCENE: Record<PhaseName, 'space' | 'atmosphere' | 'surface'> = {
  'idle-space': 'space',
  'space-to-atmosphere': 'space',
  'idle-atmosphere': 'atmosphere',
  'steady-streaming-control': 'surface',
  'atmosphere-to-surface': 'surface',
  'idle-surface': 'surface',
  disembark: 'surface',
  'walk-10m': 'surface',
  're-enter': 'surface',
  'surface-to-atmosphere': 'surface',
  'atmosphere-to-space': 'space',
};

/**
 * Which baseline each transition phase's deltas are computed against:
 *  - 'steady': the phase's own steady (untagged) frames;
 *  - 'streaming-control': the steady-streaming control at the same speed —
 *    "the same scene without the transition" for a streaming phase INCLUDES
 *    the streamer's normal 4 ms/frame contract (TASK-26), so the delta
 *    isolates the transition's excess over normal streaming;
 *  - 'idle-surface': the 3 s on-pad idle baseline (the handoff phases).
 */
type BaselineSource = 'steady' | 'streaming-control' | 'idle-surface';
const PHASE_BASELINE: Record<TransitionPhase, BaselineSource> = {
  'space-to-atmosphere': 'steady',
  'atmosphere-to-surface': 'streaming-control',
  disembark: 'idle-surface',
  'walk-10m': 'steady',
  're-enter': 'idle-surface',
  'surface-to-atmosphere': 'streaming-control',
  'atmosphere-to-space': 'steady',
};
/** A control frame doing real generation work (ms of streamer stage). */
const CONTROL_BUSY_MS = 0.5;

/** Tags that mark a frame as TRANSITION work (budgeted against baseline). */
export const TRANSITION_TAGS: ReadonlySet<string> = new Set([
  'regime-flip',
  'handoff',
  'chunk-boundary',
  'chunk-burst',
  'streamer-boot',
  'streamer-shutdown',
  'character-build',
  'character-dispose',
  'material-swap',
]);

/** Per-stage wall ms of one simulated frame (sums to ~measuredMs). */
export interface StageMs {
  atmosphereMs: number;
  streamerMs: number;
  sceneMs: number;
  cameraMs: number;
  oneShotMs: number;
}

/** One sampled frame (the onFrame callback + the report both consume this). */
export interface FrameSample {
  /** Global 0-based frame index of the run. */
  frameIndex: number;
  phase: PhaseName;
  /** Wall ms of the whole frame (beginFrame → endFrame). */
  measuredMs: number;
  stages: StageMs;
  /** Transition tags (empty = steady frame of its phase). */
  tags: string[];
  regime: Regime;
}

/** AC4: the exact culprit a budget regression names. */
export interface WorstFrame {
  transition: PhaseName;
  frameIndex: number;
  baselineMs: number;
  measuredMs: number;
  deltaMs: number;
}

/** Per-phase budget report (AC4 shape + aggregates). */
export interface PhaseReport {
  transition: PhaseName;
  frames: number;
  taggedFrames: number;
  /** The baseline the deltas were computed against (ms). */
  baselineMs: number;
  /** 'phase-steady' (p50 of untagged frames) or 'idle' (3 s idle p50). */
  baselineSource: 'phase-steady' | 'idle';
  /** Raw max delta over the budgeted set (ms; may be negative). */
  worstDeltaMs: number;
  /** p99 of the deltas — the value budgetCheck runs against. */
  worstDeltaP99Ms: number;
  worstFrame: WorstFrame | null;
  /** TASK-57 budget warnings emitted for this phase (must be 0). */
  budgetWarnings: number;
  /** Tag counts within the phase (which transition work happened). */
  tagCounts: Record<string, number>;
}

/** One idle baseline (AC2: 3 s idle → p50/p95). */
export interface IdleBaseline {
  scene: 'space' | 'atmosphere' | 'surface';
  p50Ms: number;
  p95Ms: number;
  frames: number;
}

/** The full benchmark report of one run. */
export interface CycleReport {
  phases: PhaseReport[];
  idleBaselines: IdleBaseline[];
  /** Raw max frame time over the WHOLE cycle (no-pull check: < 100). */
  maxFrameMs: number;
  totalFrames: number;
  /** Wall ms the run took on this machine. */
  wallMs: number;
  /** Worst (max) delta over all phases (per-run worst for the variance check). */
  worstDeltaMs: number;
  /** p99-of-worst over all phases. */
  worstDeltaP99Ms: number;
  /** Sum of TASK-57 budget warnings (must be 0 for a green run). */
  budgetWarnings: number;
  /** The pad's 3x3 near block was ready before pad arrival (pre-gen check). */
  padNearRingReadyAtArrival: boolean;
  /** Frames between first full 3x3-ready and arrival (-1 = never ready). */
  padNearRingFramesBeforeArrival: number;
}

export interface TransitionCycleOptions {
  /** Galaxy seed (default: the TASK-5 dev-seed fixture). */
  seed?: string;
  starId?: string;
  planetIndex?: number;
  /** Monitor to feed (default: a fresh FrameMonitor per run). */
  monitor?: FrameMonitor;
  /** AC1: called every simulated frame. */
  onFrame?: (phase: PhaseName, frameStats: FrameStats, sample: FrameSample) => void;
  /** Wall-clock cap for the whole run (fail fast, default 120 s). */
  wallTimeoutMs?: number;
}

/** Nearest-rank percentile (same math as the FrameMonitor's ring buffer). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

interface Segment {
  phase: PhaseName;
  frames: number;
  altFrom: number;
  altTo: number;
  speed: number;
  /** Signed streamer horizontal travel over the segment (m; 0 = hold). */
  streamerDeltaM: number;
}

function segFrames(from: number, to: number, speed: number): number {
  return Math.max(1, Math.round((Math.abs(to - from) / speed) * FRAME_HZ));
}

/**
 * Pure: attribute sampled frames to phases, compute per-phase baselines +
 * deltas, and budget-check them through the given TASK-57 monitor.
 * `simNowMs` injects the clock for the budget checks (deterministic tests).
 */
export function analyzeCycle(
  samples: FrameSample[],
  monitor: FrameMonitor,
  simNowMs: (frameIndex: number) => number,
): CycleReport {
  const byPhase = new Map<PhaseName, FrameSample[]>();
  for (const phase of CYCLE_PHASES) byPhase.set(phase, []);
  for (const s of samples) byPhase.get(s.phase)!.push(s);

  const idleSamples: Record<'space' | 'atmosphere' | 'surface', FrameSample[]> = {
    space: byPhase.get('idle-space')!,
    atmosphere: byPhase.get('idle-atmosphere')!,
    surface: byPhase.get('idle-surface')!,
  };
  const idleP50: Record<'space' | 'atmosphere' | 'surface', number> = {
    space: percentile(idleSamples.space.map((s) => s.measuredMs), 50),
    atmosphere: percentile(idleSamples.atmosphere.map((s) => s.measuredMs), 50),
    surface: percentile(idleSamples.surface.map((s) => s.measuredMs), 50),
  };
  const idleBaselines: IdleBaseline[] = (
    ['space', 'atmosphere', 'surface'] as const
  ).map((scene) => ({
    scene,
    p50Ms: idleP50[scene],
    p95Ms: percentile(idleSamples[scene].map((s) => s.measuredMs), 95),
    frames: idleSamples[scene].length,
  }));

  const phases: PhaseReport[] = [];
  let worstDeltaMs = 0;
  let worstDeltaP99Ms = 0;
  let budgetWarnings = 0;

  for (const phase of TRANSITION_PHASES) {
    const frames = byPhase.get(phase)!;
    const tagged = frames.filter((f) => f.tags.some((t) => TRANSITION_TAGS.has(t)));
    const steady = frames.filter((f) => !f.tags.some((t) => TRANSITION_TAGS.has(t)));

    // Baseline = the same scene WITHOUT the transition: the phase's own
    // steady frames (p50); fall back to the 3 s idle baseline of the
    // phase's scene class (the handoff phases have no steady frames).
    const useSteady = steady.length >= 30;
    const baselineMs = useSteady
      ? percentile(steady.map((s) => s.measuredMs), 50)
      : idleP50[PHASE_SCENE[phase]];

    // The budgeted set: the transition frames — or every frame when the
    // phase has none (walk-10m: any spike there is a transition bug).
    const budgetSet = tagged.length > 0 ? tagged : frames;
    const deltas = budgetSet.map((f) => f.measuredMs - baselineMs);
    let worstFrame: WorstFrame | null = null;
    for (const f of budgetSet) {
      const delta = f.measuredMs - baselineMs;
      if (worstFrame === null || delta > worstFrame.deltaMs) {
        worstFrame = {
          transition: phase,
          frameIndex: f.frameIndex,
          baselineMs: round3(baselineMs),
          measuredMs: round3(f.measuredMs),
          deltaMs: round3(delta),
        };
      }
    }
    const p99 = percentile(deltas, 99);

    const budgetName = `transition:${phase}`;
    monitor.registerBudget(budgetName, TRANSITION_BUDGET_MS);
    monitor.budgetCheck(budgetName, p99, simNowMs(budgetSet[budgetSet.length - 1].frameIndex));
    const warnings = monitor.getBudgetStats(budgetName).warnings;

    const tagCounts: Record<string, number> = {};
    for (const f of frames) for (const t of f.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;

    phases.push({
      transition: phase,
      frames: frames.length,
      taggedFrames: tagged.length,
      baselineMs: round3(baselineMs),
      baselineSource: useSteady ? 'phase-steady' : 'idle',
      worstDeltaMs: round3(worstFrame ? worstFrame.deltaMs : 0),
      worstDeltaP99Ms: round3(p99),
      worstFrame,
      budgetWarnings: warnings,
      tagCounts,
    });

    worstDeltaMs = Math.max(worstDeltaMs, worstFrame ? worstFrame.deltaMs : 0);
    worstDeltaP99Ms = Math.max(worstDeltaP99Ms, p99);
    budgetWarnings += warnings;
  }

  return {
    phases,
    idleBaselines,
    maxFrameMs: round3(Math.max(0, ...samples.map((s) => s.measuredMs))),
    totalFrames: samples.length,
    wallMs: 0, // filled in by the runner
    worstDeltaMs: round3(worstDeltaMs),
    worstDeltaP99Ms: round3(worstDeltaP99Ms),
    budgetWarnings,
    padNearRingReadyAtArrival: false,
    padNearRingFramesBeforeArrival: -1,
  };
}

function round3(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/**
 * Run the full scripted cycle once and return the report. See the module
 * doc for the methodology. Throws when the fixture cannot support the cycle
 * (airless planet) or the run exceeds `wallTimeoutMs`.
 */
export function runTransitionCycle(options: TransitionCycleOptions = {}): CycleReport {
  const seed = options.seed ?? devSeed.seed;
  const starId = options.starId ?? devSeed.starId;
  const planetIndex = options.planetIndex ?? devSeed.planetIndex;
  const monitor = options.monitor ?? new FrameMonitor();
  const wallTimeoutMs = options.wallTimeoutMs ?? 120_000;
  const wallStart = performance.now();

  const system = generateSystem(seed, starId);
  const planet = system.planets[planetIndex];
  if (!planet?.hasAtmosphere) {
    throw new Error('TASK-30: fixture planet has no atmosphere — the cycle is undefined');
  }
  const anchor = planetAnchor(planetIndex);
  const regimePlanets = systemRegimePlanets(system);
  const pad =
    padsForSystem(seed, system).find((p) => p.planetId === planet.id) ??
    padsForSystem(seed, system)[0];
  if (!pad) throw new Error('TASK-30: fixture system has no landing pad');
  // TWO coordinate spaces, as in the live client: the FLIGHT space (shared
  // sim u, planet anchor at (10000, 0)) for regime + atmosphere, and the
  // LOCAL surface space (chunk metres, chunk (0,0) at the origin) for the
  // streaming pipeline + the on-foot character. The pad's local position is
  // its world position minus the anchor (its chunk (0,0) offset).
  const padLocal: Vec3 = {
    x: pad.pos.x - anchor.x,
    y: pad.pos.y,
    z: pad.pos.z - anchor.z,
  };

  const streamer = new ChunkStreamer(seed, planet);
  const scene = new ChunkScene(streamer, { monitor });
  const threeScene = new THREE.Scene();
  threeScene.add(scene.group);
  const dome = createAtmosphereDome(ATMOSPHERE_BOUNDARY_M);
  const domeColor = new THREE.Color();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 20_000);
  // The live rig's nudge surface: the flat pad plane under the feet.
  const rig = new CameraRig({ camera, heightAt: () => pad.pos.y });
  const hazeColors = ATMOSPHERE_HAZE_COLORS;

  // The scripted flight path (see Segment). Streamer horizontal travel
  // mirrors the ship's approach/pull-away: the pad's 3x3 enters the 7x7
  // fast ring LONG before pad arrival (the pre-generation this task
  // verifies).
  // Descent approaches the pad (−X), the climb pulls away (+X). The 499 m
  // total descent travel splits with the altitudes (460 m fast + 39 m VTOL).
  const segments: Segment[] = [
    { phase: 'idle-space', frames: IDLE_FRAMES, altFrom: START_ALT_M, altTo: START_ALT_M, speed: 0, streamerDeltaM: 0 },
    { phase: 'space-to-atmosphere', frames: segFrames(START_ALT_M, MID_ALT_M, SPACE_SPEED), altFrom: START_ALT_M, altTo: MID_ALT_M, speed: SPACE_SPEED, streamerDeltaM: 0 },
    { phase: 'idle-atmosphere', frames: IDLE_FRAMES, altFrom: MID_ALT_M, altTo: MID_ALT_M, speed: 0, streamerDeltaM: 0 },
    { phase: 'atmosphere-to-surface', frames: segFrames(MID_ALT_M, VTOL_START_ALT_M, SURFACE_SPEED), altFrom: MID_ALT_M, altTo: VTOL_START_ALT_M, speed: SURFACE_SPEED, streamerDeltaM: -(MID_ALT_M - VTOL_START_ALT_M) },
    { phase: 'atmosphere-to-surface', frames: segFrames(VTOL_START_ALT_M, PAD_ALT_M, VTOL_SPEED), altFrom: VTOL_START_ALT_M, altTo: PAD_ALT_M, speed: VTOL_SPEED, streamerDeltaM: -(VTOL_START_ALT_M - PAD_ALT_M) },
    { phase: 'idle-surface', frames: IDLE_FRAMES, altFrom: PAD_ALT_M, altTo: PAD_ALT_M, speed: 0, streamerDeltaM: 0 },
    { phase: 'disembark', frames: HANDOFF_FRAMES, altFrom: PAD_ALT_M, altTo: PAD_ALT_M, speed: 0, streamerDeltaM: 0 },
    { phase: 'walk-10m', frames: Math.round((10 / WALK_SPEED) * FRAME_HZ), altFrom: PAD_ALT_M, altTo: PAD_ALT_M, speed: WALK_SPEED, streamerDeltaM: 10 },
    { phase: 're-enter', frames: HANDOFF_FRAMES, altFrom: PAD_ALT_M, altTo: PAD_ALT_M, speed: 0, streamerDeltaM: 0 },
    { phase: 'surface-to-atmosphere', frames: segFrames(PAD_ALT_M, MID_ALT_M, SURFACE_SPEED), altFrom: PAD_ALT_M, altTo: MID_ALT_M, speed: SURFACE_SPEED, streamerDeltaM: STREAM_TRAVEL_M },
    { phase: 'atmosphere-to-space', frames: segFrames(MID_ALT_M, START_ALT_M, SPACE_SPEED), altFrom: MID_ALT_M, altTo: START_ALT_M, speed: SPACE_SPEED, streamerDeltaM: 0 },
  ];

  // Live-loop state.
  let simRegime: Regime = 'space';
  let alt = START_ALT_M;
  let streaming = false;
  let streamerX = padLocal.x + STREAM_TRAVEL_M; // 499 m out: descent start
  let rigActive = false;
  let charX = padLocal.x;
  let charMesh: ReturnType<typeof buildCharacterMesh> | null = null;
  let lastTris = 0;
  let burstLeft = 0;
  let flipPending = 0;
  let padArrivalFrame = -1;
  let padNearReadyFrame = -1;

  const shipPos = (): Vec3 => ({ x: anchor.x, y: alt, z: anchor.z });
  const charPos = (): Vec3 => ({ x: charX, y: padLocal.y, z: padLocal.z });

  const samples: FrameSample[] = [];
  let frameIndex = 0;

  const disposeCharacter = (): void => {
    if (!charMesh) return;
    threeScene.remove(charMesh.group);
    charMesh.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
    charMesh = null;
  };

  const isPadNearRingReady = (): boolean => {
    const pcx = chunkOfMeters(padLocal.x);
    const pcz = chunkOfMeters(padLocal.z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!streamer.isReady(chunkKey(pcx + dx, pcz + dz))) return false;
      }
    }
    return true;
  };

  try {
    for (const seg of segments) {
      const perFrameAlt = (seg.altTo - seg.altFrom) / seg.frames;
      const perFrameX = seg.streamerDeltaM / seg.frames;

      for (let f = 0; f < seg.frames; f++) {
        // ---- advance the sim (the synthetic "teleport" timeline) ----
        if (f > 0) alt += perFrameAlt;
        if (f === seg.frames - 1) alt = seg.altTo; // land exactly
        if (f > 0 && seg.streamerDeltaM !== 0) streamerX += perFrameX;
        if (f === seg.frames - 1 && seg.streamerDeltaM !== 0) {
          streamerX += seg.streamerDeltaM - perFrameX * (seg.frames - 1); // land exactly
        }
        if (seg.phase === 'walk-10m') charX += WALK_SPEED * DT_S;

        const speed = seg.speed;
        const tags: string[] = [];

        monitor.beginFrame();
        const t0 = performance.now();
        let atmosphereMs = 0;
        let streamerMs = 0;
        let sceneMs = 0;
        let cameraMs = 0;
        let oneShotMs = 0;

        // ---- 1. atmosphere: regime resolution + the shared crossfade ----
        {
          const t = performance.now();
          const resolved = regimeFor(shipPos(), regimePlanets, simRegime, speed);
          const flipped = resolved.regime !== simRegime;
          const view = atmosphereViewFor(shipPos(), system, resolved.regime);
          if (view.planet) {
            dome.set(
              view.haze,
              domeColor
                .setRGB(
                  parseInt(hazeColors[view.planet.class].slice(1, 3), 16) / 255,
                  parseInt(hazeColors[view.planet.class].slice(3, 5), 16) / 255,
                  parseInt(hazeColors[view.planet.class].slice(5, 7), 16) / 255,
                  THREE.NoColorSpace,
                ),
            );
          } else {
            dome.set(0, domeColor);
          }
          atmosphereMs = performance.now() - t;
          if (flipped) {
            // Regime change ± 2 frames (AC2).
            tags.push('regime-flip');
            flipPending = 2;
            for (const prev of samples.slice(-2)) prev.tags.push('regime-flip');
          } else if (flipPending > 0) {
            tags.push('regime-flip');
            flipPending -= 1;
          }
          simRegime = resolved.regime;
        }

        // ---- 2+3. surface pipeline (only while the surface is live) ----
        let stats: ReturnType<ChunkStreamer['update']> | null = null;
        if (streaming) {
          const t = performance.now();
          stats = streamer.update(streamerX, padLocal.z, speed);
          streamerMs = performance.now() - t;
          const ts = performance.now();
          const meshesBefore = scene.group.children.length;
          const tris = scene.sync(streamerX, padLocal.z, speed);
          lastTris = tris.near + tris.mid + tris.far;
          sceneMs = performance.now() - ts;
          // A newly mounted mesh = a biome material first created / a mip
          // pointer swap (the "material swap" transition work).
          if (scene.group.children.length > meshesBefore) tags.push('material-swap');
          if (stats.scheduled > 0) {
            // A chunk just entered the active set: the boundary crossing.
            tags.push('chunk-boundary');
            burstLeft = BURST_DRAIN_FRAMES;
          } else if (burstLeft > 0) {
            tags.push('chunk-burst');
            burstLeft -= 1;
          }
        }

        // ---- 4. camera: the one rig of all regimes ----
        {
          const t = performance.now();
          if (rigActive) {
            const onFoot = simRegime === 'surface' && charMesh !== null;
            if (onFoot) rig.setCharacterPosition(charPos());
            else rig.setShip(shipPos(), { x: 0, y: 0, z: 0, w: 1 });
            rig.update(DT_S);
            if (rig.inputLocked) tags.push('handoff');
            cameraMs = performance.now() - t;
          }
        }

        // ---- 5. one-shot transition work ----
        if (seg.phase === 'disembark' && f === 0) {
          const t = performance.now();
          // The live disembark: spawn the character model, apply the
          // livery tint (the material swap), start the 600 ms handoff.
          charMesh = buildCharacterMesh();
          threeScene.add(charMesh.group);
          charMesh.group.position.set(charPos().x, charPos().y, charPos().z);
          charMesh.body.color.set('#7dd3fc'); // livery hull (material swap)
          charMesh.head.color.set('#e2e8f0'); // livery accent
          rig.setCharacterPosition(charPos());
          rig.handoff('onfoot'); // path precompute (5 nudged samples)
          oneShotMs = performance.now() - t;
          tags.push('character-build', 'material-swap', 'handoff');
          rigActive = true;
        }
        if (seg.phase === 're-enter' && f === 0) {
          const t = performance.now();
          // The live re-entry: dispose the capsule, reverse handoff.
          disposeCharacter();
          rig.setShip(shipPos(), { x: 0, y: 0, z: 0, w: 1 });
          rig.handoff('cockpit');
          oneShotMs = performance.now() - t;
          tags.push('character-dispose', 'handoff');
        }

        // ---- streaming boot / shutdown ----
        if (seg.phase === 'atmosphere-to-surface' && f === 0) {
          const t = performance.now();
          // Boot: the whole 7x7 fast ring is scheduled at once — the
          // boundary crossing this task exists to keep spike-free.
          streamer.update(streamerX, padLocal.z, speed);
          oneShotMs += performance.now() - t;
          tags.push('streamer-boot', 'chunk-boundary');
          burstLeft = BURST_DRAIN_FRAMES;
          streaming = true;
        }
        if (simRegime === 'space' && streaming) {
          const t = performance.now();
          streamer.reset(); // surface scene gone: dispose everything
          oneShotMs += performance.now() - t;
          tags.push('streamer-shutdown');
          streaming = false;
          lastTris = 0;
        }

        const frameMs = performance.now() - t0;
        monitor.endFrame({
          drawCalls: 3 + scene.group.children.length + (charMesh ? 2 : 0),
          triangles: lastTris,
        });
        const sample: FrameSample = {
          frameIndex,
          phase: seg.phase,
          measuredMs: frameMs,
          stages: {
            atmosphereMs: round3(atmosphereMs),
            streamerMs: round3(streamerMs),
            sceneMs: round3(sceneMs),
            cameraMs: round3(cameraMs),
            oneShotMs: round3(oneShotMs),
          },
          tags,
          regime: simRegime,
        };
        samples.push(sample);
        options.onFrame?.(seg.phase, monitor.getFrameStats(), sample);
        frameIndex += 1;

        // ---- pre-generation bookkeeping ----
        if (streaming && padNearReadyFrame === -1 && isPadNearRingReady()) {
          padNearReadyFrame = frameIndex;
        }
        if (seg.phase === 'atmosphere-to-surface' && f === seg.frames - 1 && alt <= PAD_ALT_M + 1e-9) {
          padArrivalFrame = frameIndex;
        }

        if (f % 120 === 119 && performance.now() - wallStart > wallTimeoutMs) {
          throw new Error(
            `TASK-30: cycle exceeded the ${wallTimeoutMs} ms wall budget at frame ${frameIndex} (${seg.phase})`,
          );
        }
      }
    }
  } finally {
    disposeCharacter();
    scene.dispose();
    streamer.reset();
    dome.dispose();
  }

  const report = analyzeCycle(
    samples,
    monitor,
    (fi) => fi * (1000 / FRAME_HZ),
  );
  report.wallMs = Math.round(performance.now() - wallStart);
  report.padNearRingReadyAtArrival =
    padNearReadyFrame !== -1 && (padArrivalFrame === -1 || padNearReadyFrame <= padArrivalFrame);
  report.padNearRingFramesBeforeArrival =
    padNearReadyFrame !== -1 && padArrivalFrame !== -1 ? padArrivalFrame - padNearReadyFrame : -1;
  return report;
}

// ---------------------------------------------------------------------------
// Dev-only page hook (never ships in a production build).
// ---------------------------------------------------------------------------

/** Shape of the dev surface the e2e / bench specs read. */
export interface TransitionDebug {
  /** Run the full cycle on this page's main thread (blocking). */
  runCycle(options?: TransitionCycleOptions): Promise<CycleReport>;
  /** The report of the last runCycle (null before the first). */
  lastReport: CycleReport | null;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __TRANSITION__?: TransitionDebug;
  }
}

/**
 * Install the hook on window. No-op in production builds (DEV flag false)
 * and in non-browser environments (Node bench runs import the module and
 * call runTransitionCycle directly). Called once from main.tsx.
 */
export function installTransitionDebug(): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env?.DEV) return;
  const api: TransitionDebug = {
    lastReport: null,
    runCycle: (opts) => {
      const report = runTransitionCycle(opts);
      api.lastReport = report;
      return Promise.resolve(report);
    },
  };
  window.__TRANSITION__ = api;
}
