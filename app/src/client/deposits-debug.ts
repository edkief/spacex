/**
 * TASK-37: dev-only debug hook (no-op in production builds) — exposes the
 * ore rocks the client is currently rendering on `window.__DEPOSITS__`.
 * Lets the e2e assert the client-derived deposit list (same seed as the
 * server) and the 500 m streaming ring without inspecting the GL scene.
 */
import type { OreRockView } from '@client/world/ore-rocks';

export interface DepositsDebugState {
  /** The current system's ore rocks (empty before the first world swap). */
  deposits: () => OreRockView[];
}

declare global {
  interface Window {
    __DEPOSITS__?: DepositsDebugState;
  }
}

/** Install the hook (DEV builds only); the source is bound lazily. */
export function installDepositsDebug(): DepositsDebugState | null {
  if (!import.meta.env.DEV) return null;
  const state: DepositsDebugState = { deposits: () => [] };
  window.__DEPOSITS__ = state;
  return state;
}

/**
 * Point the hook at a live source of ore rocks. The getter reads `source`
 * on every call (never per-frame from the hook itself), so a later World
 * Manager re-creation (seed correction) keeps working.
 */
export function bindDepositsDebug(
  state: DepositsDebugState | null,
  source: () => OreRockView[] | undefined,
): void {
  if (state) state.deposits = () => source() ?? [];
}
