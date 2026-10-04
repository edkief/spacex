/**
 * Ship HUD store (TASK-51) — the 10 Hz self-ship view + the hull-hit flash
 * signal, the ONLY state the ship HUD (speed/altitude/regime/nav/docked +
 * vitals bar) reads.
 *
 * The view is the server-authoritative SELF ship entity (10 Hz
 * entity_update; the client never displays a predicted value as truth —
 * prediction is for feel, the HUD is for facts). It is set only while the
 * player's own entity IS a ship (in flight or docked); on foot / before
 * the first snapshot / on a system snapshot it is null and the HUD
 * unmounts. `regime` is the server's authoritative flight regime
 * (entity.flightRegime, TASK-25) — the client's local prediction only
 * fills in when the wire field is absent (v1 back-compat).
 *
 * The hit flash is a monotonic timestamp (the last combat_event 'hit' or
 * 'destroyed' targeting the SELF ship, TASK-42 events) — the vitals bar
 * flashes red for HIT_FLASH_MS after it, same emit-on-change idiom as the
 * sibling stores.
 */
import { canonicalJson } from '@shared/canonical';
import type { Quat, Vec3 } from '@shared/protocol/schemas';
import type { Regime } from '@shared/regime';

/** One server snapshot of the player's own ship (the HUD's only input). */
export interface SelfShipView {
  pos: Vec3;
  vel: Vec3;
  rot: Quat;
  /** Hull 0..1 (server truth). */
  hull: number;
  /** Shields 0..1 (server truth). */
  shields: number;
  /** The server's authoritative flight regime (TASK-25). */
  regime: Regime;
  /** The pad id while docked (null otherwise). */
  padId: string | null;
  /** The wire frame's timestamp (ms) — monotonic across frames. */
  atMs: number;
}

/** The red-flash window after a self hit (spec: 300 ms). */
export const HIT_FLASH_MS = 300;

let view: SelfShipView | null = null;
let viewKey = '';
const viewListeners = new Set<(v: SelfShipView | null) => void>();

let lastHitAtMs = 0;
const hitListeners = new Set<(atMs: number) => void>();

/**
 * Publish one self-ship view (null clears the HUD — on foot / new
 * system). Emit-on-change: identical payloads (same wire fields and
 * frame) never re-notify; the 10 Hz cadence arrives from the caller.
 */
export function setSelfShipView(next: SelfShipView | null): void {
  const key = next ? `${canonicalJson(next)}:${next.atMs}` : 'null';
  if (key === viewKey) return;
  viewKey = key;
  view = next;
  for (const l of viewListeners) l(next);
}

/** The current view (null = HUD hidden). */
export function selfShipView(): SelfShipView | null {
  return view;
}

/** Subscribe; the listener fires immediately with the current value. */
export function selfShipViewSubscribe(listener: (v: SelfShipView | null) => void): () => void {
  viewListeners.add(listener);
  listener(view);
  return () => viewListeners.delete(listener);
}

/** Record a combat hit ON THE SELF SHIP (main.tsx routes self targets only). */
export function flashHullHit(atMs: number = Date.now()): void {
  if (atMs <= lastHitAtMs) return;
  lastHitAtMs = atMs;
  for (const l of hitListeners) l(atMs);
}

/** True while the red flash window is open (test-injectable now for fake timers). */
export function hitFlashActive(atMs: number = Date.now()): boolean {
  return lastHitAtMs > 0 && atMs >= lastHitAtMs && atMs - lastHitAtMs < HIT_FLASH_MS;
}

/** The last self-hit timestamp (0 = never hit). */
export function lastHullHitAtMs(): number {
  return lastHitAtMs;
}

export function hullHitSubscribe(listener: (atMs: number) => void): () => void {
  hitListeners.add(listener);
  if (lastHitAtMs > 0) listener(lastHitAtMs);
  return () => hitListeners.delete(listener);
}

/** Test seam. */
export function __resetShipHud(): void {
  view = null;
  viewKey = '';
  lastHitAtMs = 0;
}
