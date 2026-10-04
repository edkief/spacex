/**
 * TASK-48.3: dev-only hazard-world probe (the __HAZARD_DISCS__ hook).
 *
 * Exposes the WorldManager's rendered hazard discs (kind + world pos +
 * radius + live visibility) and the streamed drone meshes (id + world pos +
 * visibility) LAZILY against the live WorldManager — the frame loop flips
 * visibility every frame, so a cached value would lie. Lets the smoke e2e
 * assert the 3D world state (discs derived from the shared hazardsFor,
 * drones rendered from the 10 Hz stream) without inspecting the GL scene.
 *
 * Like __REMOTE_SHIPS__ / __SELF_SHIP__, installed only when
 * import.meta.env.DEV — production builds never ship it.
 */

import type { Vec3 } from '@shared/physics/vec';

export interface HazardDiscProbe {
  hazardId: string;
  kind: 'storm' | 'radzone';
  pos: Vec3;
  radius: number;
  /** Live per-frame 500 m culling state. */
  visible: boolean;
}

export interface DroneProbe {
  id: string;
  pos: Vec3;
  /** False while the wire hull is 0 (killed, awaiting the server respawn). */
  visible: boolean;
}

/** Shape of the debug surface the e2e tests read. */
export interface HazardWorldDebug {
  probe: () => {
    systemId: string | null;
    discs: HazardDiscProbe[];
    drones: DroneProbe[];
  };
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __HAZARD_DISCS__?: HazardWorldDebug;
  }
}

/** Install the hook (DEV builds only). */
export function installHazardWorldDebug(): HazardWorldDebug | null {
  if (!import.meta.env.DEV) return null;
  const state: HazardWorldDebug = { probe: () => ({ systemId: null, discs: [], drones: [] }) };
  window.__HAZARD_DISCS__ = state;
  return state;
}

/**
 * Point the hook at a live source (the WorldManager getters). The source
 * reads the manager on every call, so a later re-creation (seed correction)
 * keeps working through the same ref.
 */
export function bindHazardWorldDebug(
  state: HazardWorldDebug | null,
  source: () => ReturnType<HazardWorldDebug['probe']>,
): void {
  if (state) state.probe = source;
}
