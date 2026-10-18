/**
 * AtmosphereState — the dev-only test hook + noop provider for
 * TASK-28.
 *
 * The full ship-state pipeline (WS snapshot + position readback)
 * isn't wired yet — TASK-25 owns the regime state, TASK-22 owns
 * the flight model. TASK-28 owns the *visual* layer, which needs
 * to be mounted in the React tree so future tasks can plug the
 * live ship state in.
 *
 * To bridge the gap we ship a tiny in-process state holder:
 *
 *   - `installAtmosphereStateHook()` mounts a `window.__driftAtmosphereState`
 *     facade with `setState(altitude, descentSpeed, planet, planetAtmosphere)`.
 *   - `currentAtmosphereStateProvider()` returns the live provider
 *     that the React overlay reads every frame.
 *   - The default state is "no planet in range" so the overlay is
 *     invisible out of the box; an e2e test sets state explicitly
 *     to drive the visible transition.
 *
 * The hook is dev-only — `installAtmosphereStateHook` is gated on
 * `import.meta.env.DEV` and the provider falls back to "null"
 * when the hook isn't installed.
 */

import type { Planet } from "@shared/galaxy/types.js";
import { type PlanetAtmosphere } from "@shared/physics/atmosphere.js";
import type { AtmosphereStateProvider } from "./AtmosphereOverlay.js";

interface MutableState {
  altitude: number;
  descentSpeed: number;
  planet: Planet;
  planetAtmosphere: PlanetAtmosphere;
}

/**
 * Module-level mutable holder. Survives React re-renders because
 * it sits outside the React tree.
 */
let currentState: MutableState | null = null;

const listeners = new Set<() => void>();

export function setAtmosphereState(
  altitude: number,
  descentSpeed: number,
  planet: Planet,
  planetAtmosphere: PlanetAtmosphere,
): void {
  currentState = { altitude, descentSpeed, planet, planetAtmosphere };
  for (const listener of listeners) {
    listener();
  }
}

export function clearAtmosphereState(): void {
  currentState = null;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAtmosphereState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The provider the React overlay reads. Returns the live state
 * or `null` (no atmosphere-bearing planet in range).
 */
export const currentAtmosphereStateProvider: AtmosphereStateProvider = {
  getState() {
    if (currentState === null) return null;
    return {
      altitude: currentState.altitude,
      descentSpeed: currentState.descentSpeed,
      planet: currentState.planet,
      planetAtmosphere: currentState.planetAtmosphere,
    };
  },
};

/**
 * The dev-only test hook. Mirrors the pattern used by the
 * `__driftCameraRig` hook (TASK-27) — a thin facade on
 * `window.__driftAtmosphereState` so Playwright can drive the
 * overlay through a JSON-callable API.
 */
export interface AtmosphereTestHook {
  setState(
    altitude: number,
    descentSpeed: number,
    planet: Planet,
    planetAtmosphere: PlanetAtmosphere,
  ): void;
  clear(): void;
  getState(): {
    altitude: number;
    descentSpeed: number;
    planet: Planet;
    planetAtmosphere: PlanetAtmosphere;
  } | null;
}

/**
 * Install the hook on `window.__driftAtmosphereState`.
 *
 * Idempotent — calling twice replaces the previous hook so React
 * StrictMode double-mount doesn't crash.
 */
export function installAtmosphereTestHook(): AtmosphereTestHook {
  const hook: AtmosphereTestHook = {
    setState(altitude, descentSpeed, planet, planetAtmosphere) {
      setAtmosphereState(altitude, descentSpeed, planet, planetAtmosphere);
    },
    clear() {
      clearAtmosphereState();
    },
    getState() {
      return currentAtmosphereStateProvider.getState();
    },
  };
  (globalThis as { __driftAtmosphereState?: AtmosphereTestHook }).__driftAtmosphereState = hook;
  return hook;
}

/** Remove the hook (production cleanup + test teardown). */
export function uninstallAtmosphereTestHook(): void {
  delete (globalThis as { __driftAtmosphereState?: AtmosphereTestHook }).__driftAtmosphereState;
}
