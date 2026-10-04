/**
 * TASK-72: dev-only self-ship probe (the __SELF_SHIP__ hook).
 *
 * Exposes the rendered self-ship (classId + world position) and its
 * projected screen position, evaluated LAZILY against the live
 * WorldManager (the camera chases the ship every frame, so the projection
 * must be computed at read time, not cached). Lets the e2e assert the
 * acceptance criterion — the self ship is on screen and near the view
 * center within one snapshot of joining — without inspecting the GL scene.
 *
 * Like __CHAR__ / __DEPOSITS__, installed only when import.meta.env.DEV —
 * production builds never ship it.
 */

import type { Quat, Vec3 } from '@shared/physics/vec';

export interface SelfShipProbeResult {
  /** The rendered hull class ('scout' for a fresh player). */
  classId: string | null;
  /** World position of the ship's origin (null = not spawned yet). */
  pos: Vec3 | null;
  /** World orientation (null = not spawned yet) — TASK-74 e2e aims off the nose. */
  rot: Quat | null;
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
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __SELF_SHIP__?: SelfShipDebug;
  }
}

const EMPTY: SelfShipProbeResult = { classId: null, pos: null, rot: null, screen: null };

/** Install the hook (DEV builds only); the source is bound lazily. */
export function installSelfShipDebug(): SelfShipDebug | null {
  if (!import.meta.env.DEV) return null;
  const state: SelfShipDebug = { probe: () => EMPTY };
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
