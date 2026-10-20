/**
 * Client-side hazard store — TASK-48.
 *
 * Mirrors the per-player exposure + recovering state the server
 * pushes via `hazard_update` frames. The store is the single
 * source of truth for the HUD's radiation meter + the in-world
 * hazard marker renderer (which subscribes to the snapshot's
 * entities to discover cell + drone positions).
 *
 * Pattern matches `KillFeedStore` (TASK-47) and `TargetingStore`
 * (TASK-44): pure-TS state holder, subscribers poll via
 * `useSyncExternalStore`, the React layer doesn't manage GC.
 *
 * @see ../combat/killFeed.ts for the sibling store pattern.
 * @see ../../server/shard/hazards.ts for the authoritative math.
 */

import type { PayloadFor } from "@shared/protocol/index.js";

/** Discriminator for hazard kinds — mirrors `HazardCell.kind`. */
export type HazardKind = "storm" | "radzone" | "drones";

/**
 * A live hazard marker (storm / radzone / drone) the renderer
 * has streamed in from the entity_update wire. Position is in
 * world coords; the renderer projects to screen via the camera.
 */
export interface HazardMarker {
  readonly id: string;
  readonly kind: HazardKind;
  readonly pos: { x: number; y: number; z: number };
  readonly radius: number;
  /** Optional parent cell id (set on drones, omitted on cells). */
  readonly parentCellId: string | null;
}

/**
 * A hazard **cell** the server culled onto the `hazard_update`
 * frame (`cells`). The renderer draws a ground disc + icon per
 * cell; `kind` picks the visual (storm swirl / radzone glow /
 * drone-cell ring).
 */
export interface HazardCellMarker {
  readonly hazardId: string;
  readonly kind: HazardKind;
  readonly pos: { x: number; y: number; z: number };
  readonly radius: number;
  readonly intensity: number;
}

/**
 * Per-player hazard state. Mirrors the server's
 * `ShardPlayerHazardState`.
 */
export interface HazardState {
  /** Current exposure pool (0..50). */
  exposure: number;
  /** Wall-clock ms when recovering ends; 0 when idle. */
  recoveringUntilMs: number;
  /** True when the player is currently inside any hazard cell. */
  inHazard: boolean;
  /** Last single-tick damage delta (for HUD flash animation). */
  recentDamage: number;
  /** Wall-clock ms when this snapshot landed (for fade timing). */
  receivedAtMs: number;
  /**
   * TASK-52: hazard cell the player is *currently* inside. Drives
   * the on-foot exposure meter's icon (`storm` -> swirl,
   * `radzone` -> radiation, `drones` -> hostile-drone glyph).
   * `null` when the player is out of every cell.
   */
  currentHazard: HazardCellMarker | null;
}

/** Defaults for a fresh store (the player hasn't seen any hazards yet). */
export function defaultHazardState(nowMs?: number): HazardState {
  return {
    exposure: 50,
    recoveringUntilMs: 0,
    inHazard: false,
    recentDamage: 0,
    receivedAtMs: nowMs ?? Date.now(),
    currentHazard: null,
  };
}

// ---------------------------------------------------------------------------
// HazardStore
// ---------------------------------------------------------------------------

/**
 * Pure-TS hazard store. Subscribes via `subscribe(listener)`; the
 * WS client pushes `hazard_update` frames through `applyHazardUpdate`
 * and the renderer reads via `snapshot()` for `useSyncExternalStore`.
 *
 * Markers are pushed through `setMarkers` (called by the snapshot
 * loop on every entity_update); the store keeps the most recent
 * marker list so the renderer doesn't have to scan the entity list
 * itself.
 */
export class HazardStore {
  private state: HazardState;
  private markers: HazardMarker[] = [];
  private cells: HazardCellMarker[] = [];
  /** Player world anchor (server-pushed) — scope centre. */
  private anchor: { x: number; y: number; z: number } | null = null;
  private listeners = new Set<() => void>();
  /**
   * Stable snapshot reference. Rebuilt on every mutator call
   * so `useSyncExternalStore` sees a fresh object only when
   * state actually changed (otherwise it returns the cached
   * reference, breaking React's identity check and looping).
   */
  private cachedSnapshot: {
    state: HazardState;
    markers: readonly HazardMarker[];
    cells: readonly HazardCellMarker[];
    anchor: { x: number; y: number; z: number } | null;
  };

  constructor(nowMs?: number) {
    this.state = defaultHazardState(nowMs);
    this.markers = [];
    this.cells = [];
    this.anchor = null;
    this.cachedSnapshot = {
      state: this.state,
      markers: this.markers,
      cells: this.cells,
      anchor: this.anchor,
    };
  }

  // ---- Reads --------------------------------------------------------------

  /** Live per-player hazard state. */
  getState(): HazardState {
    return this.state;
  }

  /** Live markers (post-update). */
  getMarkers(): readonly HazardMarker[] {
    return this.markers;
  }

  /** Hazard cells the server culled onto the last update. */
  getCells(): readonly HazardCellMarker[] {
    return this.cells;
  }

  /**
   * Player world anchor from the last frame, or `null` before the
   * first `hazard_update`. The hazard scope centres on it.
   */
  getAnchor(): { x: number; y: number; z: number } | null {
    return this.anchor;
  }

  /**
   * Stable snapshot for React `useSyncExternalStore`.
   *
   * **Important**: this MUST return the same object reference
   * when nothing has changed, otherwise React's snapshot
   * identity check triggers an infinite re-render loop with
   * "The result of getSnapshot should be cached to avoid an
   * infinite loop". We cache the snapshot and only rebuild it
   * when `applyHazardUpdate` or `setMarkers` mutates state.
   */
  snapshot(): {
    state: HazardState;
    markers: readonly HazardMarker[];
    cells: readonly HazardCellMarker[];
    anchor: { x: number; y: number; z: number } | null;
  } {
    return this.cachedSnapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Mutators -----------------------------------------------------------

  /**
   * Apply a `hazard_update` payload from the WS layer.
   * `receivedAtMs` defaults to `Date.now()`.
   */
  applyHazardUpdate(payload: PayloadFor<"hazard_update">, nowMs?: number): void {
    this.state = {
      exposure: payload.exposure,
      recoveringUntilMs: payload.recoveringUntilMs,
      inHazard: payload.inHazard,
      recentDamage: payload.recentDamage ?? 0,
      receivedAtMs: nowMs ?? Date.now(),
      // TASK-52: optional `currentHazard` pointer. When the
      // payload omits the field we keep the previous value so
      // the icon doesn't flicker between two ticks of the same
      // cell; when `inHazard === false` we clear it explicitly
      // (the server omits the field for "out of hazard" frames
      // too).
      currentHazard:
        payload.currentHazard !== undefined
          ? {
              hazardId: payload.currentHazard.hazardId,
              kind: payload.currentHazard.kind,
              pos: {
                x: payload.currentHazard.pos[0],
                y: payload.currentHazard.pos[1],
                z: payload.currentHazard.pos[2],
              },
              radius: payload.currentHazard.radius,
              intensity: payload.currentHazard.intensity,
            }
          : payload.inHazard
            ? this.state.currentHazard
            : null,
    };
    // The server culls the cell list per frame; when the key is
    // absent the client keeps the previous list so a single
    // dropped field doesn't blank the discs mid-walk.
    if (payload.cells !== undefined) {
      this.cells = payload.cells.map((cell) => ({
        hazardId: cell.hazardId,
        kind: cell.kind,
        pos: { x: cell.pos[0], y: cell.pos[1], z: cell.pos[2] },
        radius: cell.radius,
        intensity: cell.intensity,
      }));
    }
    if (payload.anchor !== undefined) {
      this.anchor = { x: payload.anchor[0], y: payload.anchor[1], z: payload.anchor[2] };
    }
    this.rebuildSnapshot();
    for (const listener of this.listeners) listener();
  }

  /**
   * Replace the in-world marker list. Called by the renderer /
   * snapshot loop on every entity_update; only hazards + drone
   * entities are pushed.
   */
  setMarkers(markers: readonly HazardMarker[]): void {
    this.markers = [...markers];
    this.rebuildSnapshot();
    for (const listener of this.listeners) listener();
  }

  /**
   * Reset to the default state (post-respawn / post-warp). Called
   * on reconnect + warp-arrived so the meter doesn't leak stale
   * numbers across the boundary.
   */
  reset(nowMs?: number): void {
    this.state = defaultHazardState(nowMs);
    this.markers = [];
    this.cells = [];
    this.anchor = null;
    this.rebuildSnapshot();
    for (const listener of this.listeners) listener();
  }

  /**
   * Rebuild the cached snapshot reference. Called by every
   * mutator so the next `snapshot()` call sees a fresh object —
   * React's `useSyncExternalStore` re-renders when the
   * reference changes.
   */
  private rebuildSnapshot(): void {
    this.cachedSnapshot = {
      state: this.state,
      markers: this.markers,
      cells: this.cells,
      anchor: this.anchor,
    };
  }
}

// ---------------------------------------------------------------------------
// Hazard marker extraction (pure)
// ---------------------------------------------------------------------------

import type { ProtocolEntityState } from "@shared/protocol/index.js";

/**
 * Walk an entity snapshot and emit hazard markers:
 *   - `kind === 'drone'` → a drone marker with `parentCellId` from
 *     `entity.hazardId`.
 *   - (storm / radzone cells don't have a dedicated wire kind —
 *     the client derives them from the drone's parent hazard id +
 *     the server's hazard state, which the marker renderer doesn't
 *     currently need for v1 visuals.)
 *
 * Tests pass a synthetic array; production calls this from the
 * snapshot hook in `useEffectSync` (TASK-48 step 3).
 */
export function markersFromEntities(entities: readonly ProtocolEntityState[]): HazardMarker[] {
  const out: HazardMarker[] = [];
  for (const entity of entities) {
    if (entity.kind === "drone") {
      out.push({
        id: entity.id,
        kind: "drones",
        pos: { x: entity.pos[0], y: entity.pos[1], z: entity.pos[2] },
        radius: 8, // visual size for the drone mesh; not the cell radius
        parentCellId: entity.hazardId ?? null,
      });
    }
  }
  return out;
}
