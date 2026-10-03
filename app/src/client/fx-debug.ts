import type { CombatEvent } from './fx';

/**
 * Dev-only window.__FX__ hook (import.meta.env.DEV gate, never ships):
 * the last combat events the FX dispatcher saw + counters. The weapons
 * e2e fires a laser in the browser and asserts the laser-fired event
 * landed client-side (a denied fire never reaches this list — same
 * "events only, never local intent" contract as the FX layer).
 */
export interface FxDebugState {
  events: CombatEvent[];
  laserFlashes: number;
  impacts: number;
}

const state: FxDebugState = { events: [], laserFlashes: 0, impacts: 0 };
export const FX_RING_MAX = 20;

declare global {
  interface Window {
    __FX__?: FxDebugState;
  }
}

if (import.meta.env.DEV) {
  window.__FX__ = state;
}

/** Record one combat event (main.tsx calls this for every combat_event). */
export function recordCombatEvent(event: CombatEvent): void {
  state.events.push(event);
  if (state.events.length > FX_RING_MAX) state.events.shift();
  if (event.kind === 'laser-fired') state.laserFlashes += 1;
  if (event.kind === 'missile-impact') state.impacts += 1;
}
