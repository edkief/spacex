/**
 * TASK-72: dev-only self-ship probe (the __SELF_SHIP__ hook).
 *
 * Exposes the rendered self-ship (classId + world position), the game
 * camera's world position, and the ship's projected screen position,
 * evaluated LAZILY against the live WorldManager (the camera chases the
 * ship every frame, so the projection must be computed at read time, not
 * cached). Lets the e2e assert the acceptance criterion — the self ship is
 * on screen and near the view center within one snapshot of joining —
 * without inspecting the GL scene.
 *
 * TASK-77: the hook also records per-rendered-frame samples (ONE per frame,
 * pushed by the WorldManager's frame right after the render) and the ship
 * predictor's reconcile bookkeeping (blend/rewind/snap counts + last
 * correction distance, fed from the 10 Hz self-entity bridge) — the
 * measurement surface for the chase-camera task family.
 *
 * Like __CHAR__ / __DEPOSITS__, installed only when import.meta.env.DEV —
 * production builds never ship it.
 */

import type { Quat, Vec3 } from '@shared/physics/vec';

/** One recorded rendered frame (TASK-77 measurement). */
export interface SelfShipFrameSample {
  /** The WorldManager's frame clock (performance.now). */
  t: number;
  /** The self-ship mesh's world position at render time. */
  shipPos: Vec3;
  /** The game camera's world position at render time. */
  camPos: Vec3;
  /** The ship's screen projection (CSS px) — null when behind the camera. */
  screen: { x: number; y: number } | null;
}

/** The ship predictor's reconcile bookkeeping (TASK-77 measurement). */
export interface ReconcileStats {
  blend: number;
  rewind: number;
  snap: number;
  /** The most recent reconcile's correction distance (u), or null yet. */
  lastCorrectionDistance: number | null;
}

export interface SelfShipProbeResult {
  /** The rendered hull class ('scout' for a fresh player). */
  classId: string | null;
  /** World position of the ship's origin (null = not spawned yet). */
  pos: Vec3 | null;
  /** World orientation (null = not spawned yet) — TASK-74 e2e aims off the nose. */
  rot: Quat | null;
  /** The game camera's world position (null = not spawned yet) — TASK-77. */
  camera: { pos: Vec3 } | null;
  /**
   * Projected screen position (CSS pixels, origin top-left) + view-space
   * distance — null when the ship is not spawned or sits behind the camera.
   */
  screen: { x: number; y: number; dist: number } | null;
}

/** Shape of the debug surface the e2e tests read. */
export interface SelfShipDebug {
  /** One live probe against the current WorldManager (null world = no ship). */
  probe: () => SelfShipProbeResult;
  /** Begin one-sample-per-rendered-frame recording (idempotent). */
  startRecording: () => void;
  /** End recording, return the collected samples, and clear the buffer. */
  stopRecording: () => SelfShipFrameSample[];
  /**
   * One rendered frame (called by the WorldManager's frame right after
   * `renderer.render`); a no-op unless recording.
   */
  sampleFrame: (sample: SelfShipFrameSample) => void;
  /** Record one ClientShipPredictor.reconcile result (from the bridge). */
  recordReconcile: (
    mode: 'blend' | 'rewind' | 'snap',
    correctionDistance: number,
  ) => void;
  /** Live reconcile bookkeeping (mutated in place, read by the e2e). */
  reconcile: ReconcileStats;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __SELF_SHIP__?: SelfShipDebug;
  }
}

const EMPTY: SelfShipProbeResult = {
  classId: null,
  pos: null,
  rot: null,
  camera: null,
  screen: null,
};

/** Install the hook (DEV builds only); the source is bound lazily. */
export function installSelfShipDebug(): SelfShipDebug | null {
  if (!import.meta.env.DEV) return null;
  let frames: SelfShipFrameSample[] | null = null;
  const reconcile: ReconcileStats = {
    blend: 0,
    rewind: 0,
    snap: 0,
    lastCorrectionDistance: null,
  };
  const state: SelfShipDebug = {
    probe: () => EMPTY,
    startRecording: () => {
      if (!frames) frames = [];
    },
    stopRecording: () => {
      const out = frames ?? [];
      frames = null;
      return out;
    },
    sampleFrame: (sample) => {
      if (frames) frames.push(sample); // zero cost while not recording
    },
    recordReconcile: (mode, correctionDistance) => {
      reconcile[mode] += 1;
      reconcile.lastCorrectionDistance = correctionDistance;
    },
    reconcile,
  };
  window.__SELF_SHIP__ = state;
  return state;
}

/**
 * Point the hook at a live source (the WorldManager pair). The getter reads
 * the source on every call, so a later WorldManager re-creation (seed
 * correction) keeps working through the same ref.
 */
export function bindSelfShipDebug(
  state: SelfShipDebug | null,
  source: () => SelfShipProbeResult | null,
): void {
  if (state) state.probe = () => source() ?? EMPTY;
}
