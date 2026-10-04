/**
 * TASK-74: dev-only remote-ship probe (the __REMOTE_SHIPS__ hook).
 *
 * Exposes every rendered remote ship (kind + classId + callsign + world
 * position) with its LIVE projection through the current camera, evaluated
 * LAZILY against the WorldManager at read time — the chase camera moves
 * every frame, so a cached projection would lie. Lets the e2e assert the
 * acceptance criterion — client A sees client B's ship projected in front
 * of the camera — without inspecting the GL scene.
 *
 * Like __SELF_SHIP__ / __CHAR__ / __DEPOSITS__, installed only when
 * import.meta.env.DEV — production builds never ship it.
 */

import type { Vec3 } from '@shared/physics/vec';

export interface RemoteShipProbe {
  id: string;
  /** Wire kind: 'ship' (player) or 'ai-ship' (rogue). */
  kind: 'ship' | 'ai-ship';
  /** The rendered hull class (falls back to 'scout' for unknown ids). */
  classId: string | null;
  callsign: string | null;
  pos: Vec3 | null;
  /**
   * Projected screen position (CSS pixels, origin top-left) + view-space
   * distance — null when the ship sits behind the camera.
   */
  screen: { x: number; y: number; dist: number } | null;
}

/** Shape of the debug surface the e2e tests read. */
export interface RemoteShipsDebug {
  /** One live probe of the rendered remote-ship set (empty = none yet). */
  probe: () => RemoteShipProbe[];
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __REMOTE_SHIPS__?: RemoteShipsDebug;
  }
}

/** Install the hook (DEV builds only); the source is bound lazily. */
export function installRemoteShipsDebug(): RemoteShipsDebug | null {
  if (!import.meta.env.DEV) return null;
  const state: RemoteShipsDebug = { probe: () => [] };
  window.__REMOTE_SHIPS__ = state;
  return state;
}

/**
 * Point the hook at a live source (the WorldManager getter). The source
 * reads the layer on every call, so a later WorldManager re-creation (seed
 * correction) keeps working through the same ref.
 */
export function bindRemoteShipsDebug(
  state: RemoteShipsDebug | null,
  source: () => RemoteShipProbe[],
): void {
  if (state) state.probe = source;
}
