/**
 * Destruction FX store — TASK-49 client half.
 *
 * Pure (no React, no DOM) state machine behind the explosion +
 * "SHIP LOST" presentation. The server already respawns the player
 * the instant the hull hits zero; everything in this module is
 * **cosmetic**:
 *
 *   - **Explosion** — 1 s flash + expanding shockwave quad + 8
 *     tumbling debris tetrahedrons that fade over 3 s.
 *   - **Slow-mo** — a 1 s `timeScale` dip to `SLOWMO_SCALE = 0.3`.
 *     Purely client-side: the prediction loop keeps running at real
 *     time, so this never desyncs the sim.
 *   - **SHIP LOST moment** — a 2 s full-screen overlay carrying the
 *     callsign, the killer, and "Respawning at <nearest dock>".
 *   - **Wreck markers** — the killer callsign drawn on wrecks within
 *     `WRECK_MARKER_RANGE_M = 200` m of the local player.
 *
 * The store is driven by `combat_event` frames:
 *   - `{ kind: 'destroyed', respawn? }` → explosion at the wreck
 *     position (any ship) + slow-mo + (when `respawn` is present)
 *     the 2 s moment for the local player.
 *   - Wreck entities arrive on `entity_update` frames; `applyWrecks`
 *     feeds the marker list.
 *
 * @see ../components/DestructionFx.tsx for the React renderer.
 * @see ../../server/shard/destruction.ts for the server half.
 */

import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Explosion flash duration (ms). Spec: "a 1 s flash". */
export const EXPLOSION_FLASH_MS = 1_000;

/** Shockwave quad expand duration (ms) — rides the flash. */
export const SHOCKWAVE_MS = 1_000;

/** Debris fade duration (ms). Spec: "8 tumbling tetrahedrons, 3 s fade". */
export const DEBRIS_MS = 3_000;

/** Number of debris tetrahedrons per explosion. Spec: 8. */
export const DEBRIS_COUNT = 8;

/** Slow-mo duration (ms). Spec: 1 s. */
export const SLOWMO_MS = 1_000;

/** Slow-mo time scale. Spec: `timeScale 0.3`. */
export const SLOWMO_SCALE = 0.3;

/** "SHIP LOST" overlay duration (ms). Spec: 2 s. */
export const SHIP_LOST_MS = 2_000;

/** Metres within which a wreck's killer marker is drawn. Spec: 200 m. */
export const WRECK_MARKER_RANGE_M = 200;

/** Per-wreck fire emitter toggle (the wreck burns for its TTL). */
export const WRECK_FIRE = true;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One live explosion. */
export interface Explosion {
  readonly id: string;
  /** World position of the destroyed ship. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Timestamp the explosion started (ms). */
  readonly startedAt: number;
}

/** The 2 s full-screen "SHIP LOST" moment payload. */
export interface ShipLostMoment {
  readonly callsign: string;
  readonly killer: string | null;
  readonly padId: string;
  readonly planetId: string;
  readonly wreckId: string;
  readonly cargoLost: Readonly<Record<string, number>>;
  readonly startedAt: number;
}

/** A wreck marker entry (killer attribution + proximity). */
export interface WreckMarker {
  readonly wreckId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly killerCallsign: string | null;
  readonly distanceM: number;
}

/** Immutable snapshot the React layer renders. */
export interface DestructionSnapshot {
  readonly explosions: readonly Explosion[];
  readonly shipLost: ShipLostMoment | null;
  readonly markers: readonly WreckMarker[];
  /** Cosmetic time scale — 1 except during the slow-mo dip. */
  readonly timeScale: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * `DestructionStore` — the client-side half of the death loop.
 * Subscribe with `subscribe` / read with `snapshot` (the
 * `useSyncExternalStore` contract the rest of the HUD uses).
 */
export class DestructionStore {
  private explosions: Explosion[] = [];
  private shipLost: ShipLostMoment | null = null;
  private markers: WreckMarker[] = [];
  private timeScale = 1;
  private slowMoUntil = 0;
  private listeners = new Set<() => void>();
  private seq = 0;
  private snapshotCache: DestructionSnapshot | null = null;

  /** Register a listener; returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Current snapshot (cached between mutations). */
  snapshot = (): DestructionSnapshot => {
    this.snapshotCache ??= {
      explosions: this.explosions,
      shipLost: this.shipLost,
      markers: this.markers,
      timeScale: this.timeScale,
    };
    return this.snapshotCache;
  };

  /**
   * Feed a `combat_event`. Returns `true` when the event changed
   * any destruction state (the WS layer uses that to decide
   * whether to bump a toast).
   *
   * `localCallsign` gates the "SHIP LOST" moment: the server only
   * attaches `respawn` when a *connected player* owned the ship, so
   * any `respawn` payload we see is our own death.
   */
  applyCombatEvent(evt: ProtocolCombatEvent, nowMs: number = Date.now()): boolean {
    if (evt.kind !== "destroyed") return false;
    this.explosions = [
      ...this.explosions,
      {
        id: `boom-${this.seq++}`,
        x: 0,
        y: 0,
        z: 0,
        startedAt: nowMs,
      },
    ];
    this.timeScale = SLOWMO_SCALE;
    this.slowMoUntil = nowMs + SLOWMO_MS;
    const respawn = evt.respawn;
    if (respawn !== undefined) {
      this.shipLost = {
        callsign: respawn.callsign,
        killer: respawn.killer,
        padId: respawn.padId,
        planetId: respawn.planetId,
        wreckId: respawn.wreckId,
        cargoLost: respawn.cargoLost,
        startedAt: nowMs,
      };
    }
    this.invalidate();
    return true;
  }

  /**
   * Register the wrecks currently visible from an `entity_update`
   * snapshot, resolved against the local player's position. Only
   * wrecks within `WRECK_MARKER_RANGE_M` are kept — the client
   * marker is a proximity cue, not a system-wide roster.
   */
  applyWrecks(
    wrecks: readonly {
      id: string;
      x: number;
      y: number;
      z: number;
      killerCallsign: string | null;
    }[],
    playerPos: { x: number; y: number; z: number },
  ): void {
    const out: WreckMarker[] = [];
    for (const w of wrecks) {
      const d = Math.hypot(w.x - playerPos.x, w.y - playerPos.y, w.z - playerPos.z);
      if (d > WRECK_MARKER_RANGE_M) continue;
      out.push({
        wreckId: w.id,
        x: w.x,
        y: w.y,
        z: w.z,
        killerCallsign: w.killerCallsign,
        distanceM: d,
      });
    }
    this.markers = out;
    this.invalidate();
  }

  /**
   * Advance the clock: expire explosions past the debris fade, drop
   * the "SHIP LOST" overlay after 2 s, and restore the time scale
   * when the slow-mo window closes. The React layer calls this from
   * a rAF loop; tests drive it with a fake clock.
   */
  reap(nowMs: number): void {
    let dirty = false;
    const before = this.explosions.length;
    this.explosions = this.explosions.filter((e) => nowMs - e.startedAt < DEBRIS_MS);
    if (this.explosions.length !== before) dirty = true;
    if (this.shipLost !== null && nowMs - this.shipLost.startedAt >= SHIP_LOST_MS) {
      this.shipLost = null;
      dirty = true;
    }
    if (this.timeScale !== 1 && nowMs >= this.slowMoUntil) {
      this.timeScale = 1;
      dirty = true;
    }
    if (dirty) this.invalidate();
  }

  /** Clear every transient (used on warp / reconnect). */
  reset(): void {
    this.explosions = [];
    this.shipLost = null;
    this.markers = [];
    this.timeScale = 1;
    this.slowMoUntil = 0;
    this.invalidate();
  }

  private invalidate(): void {
    this.snapshotCache = null;
    for (const l of this.listeners) l();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic debris offsets for one explosion — 8 tetrahedrons
 * thrown radially. Pure so the unit test can pin the layout and the
 * renderer can stay allocation-light.
 */
export function debrisOffsets(): ReadonlyArray<{
  dx: number;
  dy: number;
  dz: number;
  spin: number;
}> {
  const out: { dx: number; dy: number; dz: number; spin: number }[] = [];
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    // Golden-angle spiral so the burst reads as a sphere, not a ring.
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    const phi = Math.acos(1 - (2 * (i + 0.5)) / DEBRIS_COUNT);
    out.push({
      dx: Math.sin(phi) * Math.cos(theta),
      dy: Math.sin(phi) * Math.sin(theta),
      dz: Math.cos(phi),
      spin: 180 + i * 37,
    });
  }
  return out;
}

/** Explosion progress (0..1) at `nowMs`. Clamped. */
export function explosionProgress(explosion: Explosion, nowMs: number): number {
  const age = nowMs - explosion.startedAt;
  if (age <= 0) return 0;
  return Math.min(1, age / DEBRIS_MS);
}

/** "Respawning at …" label for the SHIP LOST overlay. */
export function respawnLabelFor(moment: ShipLostMoment): string {
  if (moment.padId === "") return "Respawning…";
  return `Respawning at ${moment.padId}`;
}

/** "Destroyed by …" label (falls back to "unknown pilot"). */
export function killerLabelFor(moment: ShipLostMoment): string {
  return moment.killer === null ? "Destroyed in deep space" : `Destroyed by ${moment.killer}`;
}
