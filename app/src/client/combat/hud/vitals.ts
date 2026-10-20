/**
 * Hull / shield vitals bar — TASK-51.
 *
 * Two bars stacked (shield on top, hull underneath) in the top-left
 * HUD slot, 200 px wide. The numbers fade into a tooltip on hover
 * so the bar stays clean in flight.
 *
 * The red flash is a 300 ms CSS class overlay: when the local ship
 * takes a `combat_event { kind: 'hit' | 'damaged' }` frame, the bar
 * pulses red for `HIT_FLASH_MS`. The flash math lives here so the
 * component stays a renderer of `(shouldFlash, ratio)` and the unit
 * suite can run the decay with fake timers.
 *
 * @see ../components/VitalsBar.tsx for the consumer.
 */

import type { Vec3Like } from "../../camera/types.js";

/** Width of the vitals bar — spec: 200 px. */
export const VITALS_BAR_WIDTH_PX = 200;

/** Total height of the stacked shield + hull bars + label. */
export const VITALS_BAR_HEIGHT_PX = 28;

/** Hit-flash duration in ms — spec: 300 ms. */
export const HIT_FLASH_MS = 300;

/** Local ship id (callsign or `entity:<shipId>`) used to identify self. */
export type LocalShipId = string;

/**
 * State of a self-directed hit flash. Pure data — the React
 * component reads this each tick and decides whether to apply the
 * class overlay.
 */
export interface HitFlashState {
  /** True while the flash should be visible. */
  readonly flashing: boolean;
  /** True exactly when the current wall-clock is within `HIT_FLASH_MS`
   * of the most recent self-hit event. */
  // (semantic helper — derived in `tickHitFlash`)
}

/**
 * Hit-flash controller: pure logic over an "last self-hit" timestamp.
 *
 * The `selfId` is the local player's id as seen by the
 * `TargetingStore` (the playerId resolved at auth time, or the
 * callsign fallback). The setter is invoked by an event listener
 * wired at App.tsx mount, and `tickHitFlash(nowMs)` is called from
 * the HUD's render loop to decide whether the class is active.
 */
export class HitFlashController {
  private lastFlashAtMs: number | null = null;

  /**
   * Register a hit against the local ship.  Idempotent — a new hit
   * within the flash window simply restarts the window.
   */
  recordSelfHit(atMs: number): void {
    if (!Number.isFinite(atMs)) return;
    this.lastFlashAtMs = atMs;
  }

  /** True when the current wall-clock is within the flash window. */
  isFlashing(nowMs: number): boolean {
    if (this.lastFlashAtMs === null) return false;
    const elapsed = nowMs - this.lastFlashAtMs;
    return elapsed >= 0 && elapsed < HIT_FLASH_MS;
  }

  /** Drop the flash after a long quiet period (test seam). */
  reset(): void {
    this.lastFlashAtMs = null;
  }

  /** Test seam — read the latest timestamp. */
  getLastFlashAtMs(): number | null {
    return this.lastFlashAtMs;
  }
}

/**
 * Helper for `combat_event` consumers — given a `damaged` event and
 * the local-ship id, decide whether the flash should fire and,
 * when so, what the source timestamp is.
 *
 * Only `kind === 'hit' | 'damaged'` events trigger the flash
 * (the `destroyed` event also counts when the destroyed entity IS
 * the local ship — the red pulse of a fatal hit is the flash's
 * natural extension). For simplicity v1 only flashes on the two
 * damage-kinds; the destructed pipeline already renders the big
 * 1 s explosion + 2 s SHIP LOST moment that would dwarf the bar
 * flash anyway.
 */
export function shouldFlashSelfHit(
  eventKind: string,
  targetEntityId: string,
  selfId: LocalShipId | null,
): boolean {
  if (selfId === null) return false;
  if (eventKind !== "hit" && eventKind !== "damaged") return false;
  if (targetEntityId !== selfId) return false;
  return true;
}

/**
 * Compute the displayed bar fill ratio.
 *
 * `value` is the current HP; `max` is the class's max (the same
 * table the `TargetBox` uses). Bars clamp to `[0, 1]`, and a
 * non-positive / non-finite `max` reads as empty.
 */
export function vitalsRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  if (value <= 0) return 0;
  return Math.min(1, value / max);
}

/**
 * Two-tone shield bar — the upper track in the vitals bar.
 * Shields are blue `#7cc7ff` when above 35 %, amber when low,
 * red when empty.  The hull bar's toning lives in the consumer so
 * it can share the hit-flash overlay class without a circular
 * dependency.
 */
export function shieldFillColor(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "#3a3f4d";
  if (ratio < 0.1) return "#d04848";
  if (ratio < 0.35) return "#f5b94d";
  return "#7cc7ff";
}

/** Hull amber ramp — used by both the vitals bar and the target box. */
export function hullFillColor(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "#3a3f4d";
  if (ratio < 0.1) return "#d04848";
  if (ratio < 0.35) return "#f5b94d";
  return "#f5b94d"; // hull stays amber regardless of state
}

/** Type alias re-export so consumers don't need to import `Vec3Like`
 *  separately for the local-ship snapshot. */
export type LocalShipPosLike = Vec3Like;
