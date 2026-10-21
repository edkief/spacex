/**
 * Guidance constants, storage helpers, and the event → step table
 * (TASK-56).
 *
 * Pure data + pure functions: nothing here holds mutable state, so
 * the table can be imported by the UI, the state machine, and the
 * tests without dragging React (or the store) along.
 *
 * @see ./GuidanceStore.ts for the state machine.
 * @see ../guidance.ts for the barrel re-export.
 */
// ---------------------------------------------------------------------------
// Constants — exported so the overlay + tests reach one source of truth
// ---------------------------------------------------------------------------

/** localStorage key for the persisted furthest-reached step. */
export const GUIDANCE_STORAGE_KEY = "drift.guidance";

/** Steps are zero-indexed; the finale is `STEP_FINALE`. */
export const STEP_FLY = 0;
export const STEP_DISEMBARK = 1;
export const STEP_SELL = 2;
export const STEP_FINALE = 3;

/**
 * The copy table. Kept here (not in the React file) so the state
 * machine can publish it for e2e assertions without a DOM render.
 */
export const GUIDANCE_STEPS: readonly string[] = [
  "Hold W to fly toward the star. Press M for the star chart.",
  "Press E at a docked ship to go on foot. Find an ore deposit.",
  "Load your ore into the cargo hold (E at your ship), then sell it at the dock terminal.",
  "You are drifting. Good luck.",
] as const;

/**
 * Auto-hide delay for the finale — the player has done all four
 * guideposts and we fade the line away. Five seconds feels long
 * enough to read it; the spec confirms this in the TASK-56 step
 * 3 acceptance.
 */
export const FINALE_AUTOHIDE_MS = 5_000;

/** Event names the machine recognizes. */
export type GuidanceEvent = "docked" | "disembark" | "firstPickup" | "firstSale" | "dismiss";

/** Listener signature. */
export type GuidanceListener = (state: GuidanceState) => void;

// ---------------------------------------------------------------------------
// Storage abstraction (matches SettingsStore — let tests pass a fake)
// ---------------------------------------------------------------------------

export interface GuidanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Read the persisted step, falling back to `null` for fresh players. */
export function readStep(storage: GuidanceStorage | null): number | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(GUIDANCE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { step?: unknown };
    const step = parsed.step;
    if (typeof step !== "number") return null;
    if (!Number.isFinite(step) || step < 0) return null;
    const floored = Math.floor(step);
    // Cap at STEP_FINALE so a corrupt / out-of-range payload
    // (a future write, a manual edit, a migration leak) degrades
    // to the fresh-player default instead of pinning the player
    // to a non-existent step.
    if (floored > STEP_FINALE) return null;
    return floored;
  } catch {
    return null;
  }
}

/** Persist the furthest-reached step (best-effort). */
export function writeStep(storage: GuidanceStorage | null, step: number): void {
  if (storage === null) return;
  try {
    storage.setItem(GUIDANCE_STORAGE_KEY, JSON.stringify({ step }));
  } catch {
    // Storage may be unavailable (private mode, quota). The in-memory
    // snapshot still drives this session.
  }
}

/** Clear the persistence (used by the dismiss path). */
export function clearStep(storage: GuidanceStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(GUIDANCE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** The browser's `localStorage`, or `null` when unavailable. */
export function defaultStorage(): GuidanceStorage | null {
  try {
    return (globalThis as { localStorage?: GuidanceStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/**
 * Public snapshot of the guidance state.
 *
 * `step` is the *current* step index (`STEP_FLY..STEP_FINALE`). The
 * furthest step the player reached is exposed separately so the
 * overlay can persist it on `disembark` / `firstPickup` / etc. —
 * the machine advances the public `step` immediately on the
 * matching event but persists only when the relevant event lands.
 */
export interface GuidanceState {
  /** Current visible step. `null` when the hint line is hidden. */
  step: number | null;
  /** Furthest step the player has reached (used for persistence). */
  furthest: number;
  /** `true` after the player pressed X — never re-shows. */
  dismissed: boolean;
  /** Monotonic counter — bumps on every commit, used by useSyncExternalStore. */
  revision: number;
  /** Wall-clock ms the finale was entered (drives the auto-hide). */
  finaleStartedAtMs: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the target step for a given event. `null` when the event
 * is unknown. The mapping is the spec's only server-independent
 * event table — preserve the order so the players see the four
 * hints in spec order.
 *
 * Extracted as a pure function so the unit tests can pin the
 * transition table without instantiating a store.
 */
export function targetStepFor(event: GuidanceEvent): number | null {
  switch (event) {
    case "docked":
      // The first dock lands the player on the dock prompt →
      // disembark step. This is the most common skip — the
      // starter ship is already docked at the home-system dock
      // when the player spawns, so the very first frame after
      // claim can already trigger this transition.
      return STEP_DISEMBARK;
    case "disembark":
      // Explicit disembark (E key at a docked ship) advances
      // past the disembark tip to the cargo/sell tip.
      return STEP_SELL;
    case "firstPickup":
      // Mining gives the player their first inventory unit. We
      // jump straight to the sell tip — the cargo-load sentence
      // is the next-step copy anyway.
      return STEP_SELL;
    case "firstSale":
      // Sold the first unit → finale.
      return STEP_FINALE;
    case "dismiss":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Detection helpers — small wrappers the App.tsx wires to the
// DriftClient event stream. Kept as module-level functions so the
// App only needs one call site per event.
// ---------------------------------------------------------------------------

/**
 * Decide whether a snapshot transition implies a fresh dock. The
 * predictor publishes `state.onPad`; a non-null value while the
 * previous value was null/undefined counts as the first dock.
 *
 * Returning `true` from the helper does NOT trigger the event
 * directly — the caller (App.tsx) is responsible for guarding
 * against the storage-flip noise (e.g. a re-render that briefly
 * clears `onPad`).
 */
export function dockTransitioned(
  prev: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const prevEmpty = prev === null || prev === undefined;
  const nextPresent = typeof next === "string" && next.length > 0;
  return prevEmpty && nextPresent;
}
