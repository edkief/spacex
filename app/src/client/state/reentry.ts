/**
 * Re-entry tint state (TASK-28.2) — one cosmetic number for the whole
 * client: the orange rim intensity in [0, REENTRY_TINT_MAX].
 *
 * Driven by the live session's self entity_update handler (10 Hz) from the
 * SHARED math `reentryTintFactor` (TASK-28) — this module only stores and
 * broadcasts the value, it computes nothing. The CSS overlay
 * (ui/reentry-tint.tsx) subscribes; NO physics reads this (v1 assumption:
 * re-entry heating is NOT simulated, the tint is purely cosmetic).
 *
 * Follows the subscribe/emit idiom of src/client/state/warp.ts:
 * set → clamp → emit only on change; late subscribers get the current
 * value immediately.
 */

import { REENTRY_TINT_MAX } from '@shared/physics/atmosphere';

type TintListener = (value: number) => void;

const listeners = new Set<TintListener>();
let current = 0;

/** Set the tint; clamped to [0, REENTRY_TINT_MAX], emitted only on change. */
export function setReentryTint(value: number): void {
  const next = Math.min(Math.max(value, 0), REENTRY_TINT_MAX);
  if (next === current) return;
  current = next;
  for (const fn of [...listeners]) fn(next);
}

/** The current tint (0 when not re-entering). */
export function reentryTint(): number {
  return current;
}

/** Subscribe to tint changes. Calls fn(currentValue) immediately; returns the unsubscribe. */
export function reentryTintSubscribe(fn: TintListener): () => void {
  listeners.add(fn);
  fn(current); // late subscribers catch up
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + reset to 0 (mirrors __resetWarpPhase). */
export function __resetReentryTint(): void {
  listeners.clear();
  current = 0;
}
