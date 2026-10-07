/**
 * TASK-83: dev-only planet probe (the __PLANETS__ hook).
 *
 * Exposes, per planet of the current system: the sim anchor, the true
 * camera→anchor distance, the live proxy scale (1 = true position), and the
 * anchor's projected screen position — evaluated LAZILY against the live
 * WorldManager (the proxy re-anchors every frame, so all of it must be
 * computed at read time, not cached). Lets the e2e assert the acceptance
 * criterion — a planet is visible from 6 km — without inspecting the GL
 * scene.
 *
 * Like __SELF_SHIP__ / __DEPOSITS__, installed only when import.meta.env.DEV
 * — production builds never ship it.
 */

/** One planet's live probe entry. */
export interface PlanetProbe {
  planetId: string;
  /** The sim anchor (y = 0) the planet is rendered at. */
  anchor: { x: number; y: number; z: number };
  /** True camera→anchor distance (m) — exceeds CAMERA_FAR for far planets. */
  distance: number;
  /** The current proxy scale (1 = true position and scale). */
  scale: number;
  /** The anchor's screen projection (CSS px, top-left origin) — exact for
   * proxies too (they sit on the camera→anchor ray). Null when the anchor
   * is behind the camera. */
  screen: { x: number; y: number; dist: number } | null;
}

/** TASK-84: the live streamed-terrain mount (null = no terrain mounted). */
export interface TerrainProbe {
  /** The planet whose terrain is mounted. */
  planetId: string;
  /** How many of that planet's chunks are currently mounted. */
  mountedChunks: number;
}

/** Shape of the debug surface the e2e tests read. */
export interface PlanetsDebug {
  /** One live probe over the current system's planets (empty = no world). */
  probe: () => PlanetProbe[];
  /** The live streamed-terrain mount (TASK-84; null in space / no world). */
  terrain: () => TerrainProbe | null;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __PLANETS__?: PlanetsDebug;
  }
}

/** Install the hook (DEV builds only); the source is bound lazily. */
export function installPlanetsDebug(): PlanetsDebug | null {
  if (!import.meta.env.DEV) return null;
  const state: PlanetsDebug = { probe: () => [], terrain: () => null };
  window.__PLANETS__ = state;
  return state;
}

/**
 * Point the hook at a live source (the WorldManager). The getter reads the
 * source on every call, so a later WorldManager re-creation (seed
 * correction) keeps working through the same ref. `terrainSource` is the
 * TASK-84 streamed-terrain mount (bound independently so the two probes
 * stay decoupled).
 */
export function bindPlanetsDebug(
  state: PlanetsDebug | null,
  source: () => PlanetProbe[] | null,
  terrainSource?: () => TerrainProbe | null,
): void {
  if (!state) return;
  state.probe = () => source() ?? [];
  if (terrainSource) state.terrain = terrainSource;
}
