/**
 * On-foot HUD math — TASK-52.
 *
 * Pure helpers for the on-foot HUD's three regions (exposure meter,
 * weight bar, interaction line). Every helper here is data — no
 * React, no DOM, no globals — so it composes with the existing
 * `combat/hud/*` helpers and is cheap to call from a per-frame
 * render loop (the task budget is < 0.5 ms/frame on foot).
 *
 * @see ../components/ExposureMeter.tsx — the bar UI
 * @see ../components/WeightBar.tsx — re-uses `weightBarFillColor`
 * @see ../components/InteractionLine.tsx — the prompt + radial line
 *
 * Acceptance criteria (TASK-52):
 *
 *   - Exposure meter (vertical, 0..50) green > 25, amber 10-25,
 *     red < 10; recovering state replaces the readout with a
 *     pulsing countdown.
 *   - Weight bar uses the TASK-34 thresholds (amber near cap, red
 *     at cap); the hover tooltip lists every non-zero stack.
 *   - Interaction line shows one prompt at a time; nearest wins.
 */
import type { HazardKind } from "@shared/world/hazards.js";

/** Maximum exposure pool (mirrors `HAZARD_EXPOSURE_MAX`). */
export const EXPOSURE_MAX = 50;

/** Recovering duration after a knock-down (TASK-48 spec: 5 s). */
export const RECOVERING_DURATION_MS = 5_000;

/** Inventory weight cap (mirrors `INVENTORY_WEIGHT_CAP = 40`). */
export const CARRY_WEIGHT_CAP = 40;

// ---------------------------------------------------------------------------
// Exposure meter
// ---------------------------------------------------------------------------

/** Exposure thresholds (TASK-52 spec). */
export const EXPOSURE_THRESHOLDS = {
  /** Above this value the meter is green. */
  greenMin: 25,
  /** Below this value the meter flips amber; the spec uses 10-25. */
  amberMin: 10,
  /** Below this value the meter flips red; the spec uses < 10. */
} as const;

/**
 * Compute the bar fill fraction `0..1`. Values outside the range
 * clamp cleanly (a recovering player has `exposure = 0`).
 */
export function exposureBarFraction(exposure: number): number {
  if (!Number.isFinite(exposure)) return 0;
  return Math.max(0, Math.min(1, exposure / EXPOSURE_MAX));
}

/**
 * Bar colour per the spec thresholds.
 *   exposure > 25  -> green (#34d399)
 *   exposure 10-25 -> amber (#f59e0b)  (includes the boundaries)
 *   exposure < 10  -> red   (#ff3344)
 */
export function exposureBarColor(exposure: number): string {
  if (exposure > EXPOSURE_THRESHOLDS.greenMin) return "#34d399";
  if (exposure >= EXPOSURE_THRESHOLDS.amberMin) return "#f59e0b";
  return "#ff3344";
}

/** Decide whether the bar should flash red (CSS pulse). */
export function shouldFlashExposure(
  exposure: number,
  recoveringUntilMs: number,
  nowMs: number,
): boolean {
  if (recoveringUntilMs > nowMs) return true;
  return exposure < EXPOSURE_THRESHOLDS.amberMin;
}

/**
 * Recovering state snapshot — the bar freezes at the current
 * exposure (typically 0) and a 5 s countdown ticks down.
 */
export interface RecoveringState {
  /** True while the player is recovering. */
  recovering: boolean;
  /** Whole-second countdown floored from the remaining ms. */
  secondsRemaining: number;
  /** Exact ms remaining (clamped to `>= 0`). */
  msRemaining: number;
}

export function recoveringState(recoveringUntilMs: number, nowMs: number): RecoveringState {
  const msRemaining = Math.max(0, recoveringUntilMs - nowMs);
  return {
    recovering: msRemaining > 0,
    secondsRemaining: Math.ceil(msRemaining / 1000),
    msRemaining,
  };
}

/**
 * Compute the exposure icon for the HUD label. When
 * `currentHazard` is provided we honour it (storm -> swirl,
 * radzone -> radiation, drones -> hostile-drone). When absent
 * the meter renders a neutral hazard triangle so the player
 * still sees *some* glyph.
 */
export interface HazardGlyph {
  /** Icon shape family. */
  family: "radiation" | "storm" | "drones" | "neutral";
  /** Per-kind colour (CSS hex). */
  color: string;
}

export function hazardGlyph(currentHazard: { kind: HazardKind } | null | undefined): HazardGlyph {
  if (!currentHazard) {
    return { family: "neutral", color: "rgba(255, 255, 255, 0.35)" };
  }
  switch (currentHazard.kind) {
    case "radzone":
      return { family: "radiation", color: "#7CFF6B" };
    case "storm":
      return { family: "storm", color: "#A78BFA" };
    case "drones":
      return { family: "drones", color: "#F87171" };
    default:
      return { family: "neutral", color: "rgba(255, 255, 255, 0.5)" };
  }
}

// ---------------------------------------------------------------------------
// Weight bar (mirrors the TASK-34 thresholds for parity)
// ---------------------------------------------------------------------------

export interface WeightBarState {
  fill: number;
  color: string;
  pct: number;
}

export function weightBarState(weightUsed: number): WeightBarState {
  const safe = Math.max(0, weightUsed);
  const fill = Math.max(0, Math.min(1, safe / CARRY_WEIGHT_CAP));
  const pct = Math.round(fill * 100);
  let color = "#9aa6b2";
  if (fill >= 0.95) color = "#d04848";
  else if (fill >= 0.7) color = "#f5b94d";
  return { fill, color, pct };
}

/**
 * Format the hover tooltip stack list ("iron x12, crystal x2").
 * Stacks with zero amount are dropped; entries are sorted by
 * resource id for a stable display.
 */
export function formatWeightTooltip(stacks: Readonly<Partial<Record<string, number>>>): string {
  const entries = (Object.entries(stacks) as Array<[string, number]>)
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "(empty)";
  return entries.map(([id, amount]) => `${id} x${amount}`).join(", ");
}

// ---------------------------------------------------------------------------
// Interaction line — nearest-wins pre-sort
// ---------------------------------------------------------------------------

/**
 * Sort + select the nearest interactable when two are simultaneously
 * in range. The cone-raycast in `@client/input/interaction.ts` already
 * picks the single nearest target; this helper is the defensive
 * second-pass that the InteractionLine uses when the host passes a
 * pre-resolved list (e.g. an e2e test injecting two targets).
 */
export interface InteractableLite {
  readonly id: string;
  readonly distance: number;
}

export function pickNearest<T extends InteractableLite>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  let best: T = items[0]!;
  for (let i = 1; i < items.length; i++) {
    const next = items[i]!;
    if (next.distance < best.distance) best = next;
  }
  return best;
}
