/**
 * useHudMode — TASK-52 HUD mode selector.
 *
 * Single source of truth for which HUD subtree (ship / on-foot) is
 * currently rendered. The mode is whatever the owning `Controls`
 * instance reports (`isOnFoot()`): the WS layer flips the flag on
 * the entity_update envelope's `kind === "character"` discriminator
 * and on `enter_ship_ok`, so the HUD sees the same atomic flip
 * that the camera + controls see.
 *
 * The HUD subscribes via `onRegimeChange` because the
 * existing `setOnFoot(...)` implementation fires that listener on
 * every transition (both regime transitions AND on-foot toggles).
 * That keeps the mode-switch testable: a test can mount
 * `<OnFootHUD>` and trigger a regime change to assert the subtree
 * unmounts cleanly.
 *
 * Returns a discriminated `HudMode` union so call sites can `switch`
 * exhaustively.
 *
 * Dev override:
 *   The e2e harness writes `window.__driftHudModeOverride` to force
 *   one subtree without racing the WS layer (the WS layer calls
 *   `controls.setOnFoot(ent.kind === 'character')` on every
 *   `entity_update`, so the test cannot pin the mode by mutating
 *   the controls directly). The override wins on every tick.
 */
import { useEffect, useState } from "react";

import type { Controls } from "../input/controls.js";

export type HudMode = "ship" | "character";

export interface UseHudModeResult {
  /** Current HUD mode. */
  mode: HudMode;
}

export type HudModeOverride = HudMode | null;

declare global {
  interface Window {
    __driftHudModeOverride?: HudModeOverride;
  }
}

function readOverride(): HudModeOverride {
  if (typeof window === "undefined") return null;
  return window.__driftHudModeOverride ?? null;
}

/**
 * Subscribe to the DriftClient's `__driftClient.controlsManager` for the
 * on-foot bit. Returns `mode: "character"` while the local entity
 * is a character (on foot), `mode: "ship"` otherwise.
 *
 * The hook polls the controls on a 250 ms heartbeat AND on regime
 * change events — the regime-change listener handles frame-locked
 * transitions (the camera handoff fires before the next snapshot),
 * while the interval picks up slower updates (e.g. a debug
 * `setOnFoot` from a future task).
 *
 * When `window.__driftHudModeOverride` is non-null the override
 * wins (e2e seam; the production path stays controls-driven).
 */
export function useHudMode(): UseHudModeResult {
  const [mode, setMode] = useState<HudMode>("ship");

  useEffect(() => {
    const w = window as unknown as { __driftClient?: { controlsManager?: Controls } };
    const controls = w.__driftClient?.controlsManager;
    const refresh = (): void => {
      const override = readOverride();
      if (override !== null) {
        setMode(override);
        return;
      }
      if (!controls) {
        setMode("ship");
        return;
      }
      setMode(controls.isOnFoot() ? "character" : "ship");
    };
    refresh();
    const off = controls ? controls.onRegimeChange(refresh) : () => undefined;
    const id = window.setInterval(refresh, 250);
    return () => {
      window.clearInterval(id);
      off();
    };
  }, []);

  return { mode };
}

/**
 * Pure helper for tests: resolve the HUD mode from a supplied
 * `Controls` instance without React. Returns `"character"` when
 * `controls.isOnFoot()` is `true`, `"ship"` otherwise.
 */
export function hudModeForControls(controls: Controls | undefined | null): HudMode {
  if (!controls) return "ship";
  return controls.isOnFoot() ? "character" : "ship";
}
