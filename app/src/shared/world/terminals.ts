/**
 * Dock terminals (TASK-40) — the station's sell-terminal geometry: one
 * terminal per station, at the pad edge, DERIVED from the seed exactly
 * like the pads themselves (positions are never stored — PRD §6).
 *
 * In v1 every system's station is its dock, and the terminal is the
 * on-foot interactable at the station: the shard spawns one static
 * 'terminal' entity per pad (the same entity kind the TASK-33 'ui-open'
 * flow already dispatches), and "at a station" for on-foot selling means
 * within TERMINAL_RANGE_M of one of them (the server validates the
 * character position against these entities — TASK-40 AC).
 *
 * The terminal sits on the flat pad disc, a few metres in from the rim
 * ("at the pad edge"): a deterministic angle per pad (hash of the pad id),
 * at distance pad.radius − 2, so it always stands on the flat pad plane
 * where the character can walk.
 */

import { Rng, hash2, seedFromString } from '../random';
import type { SystemGen } from '../galaxy/types';
import { padsForSystem, type PadInfo } from './pads';
import type { Vec3 } from '../physics/vec';

/**
 * The sell range: an ON-FOOT player within this distance (10 m, TASK-40
 * AC) of a station terminal is "at a station" and may sell from the
 * on-foot inventory.
 */
export const TERMINAL_RANGE_M = 10;

/** Meters in from the pad rim the terminal stands (flat pad plane). */
export const TERMINAL_EDGE_OFFSET_M = 2;

/** The wire/stable entity id of one pad's terminal. */
export function terminalIdFor(pad: PadInfo): string {
  return `terminal:${pad.padId}`;
}

/** The terminal position for one pad (derived — deterministic per pad id). */
export function terminalPosFor(pad: PadInfo): Vec3 {
  // One deterministic angle per pad (0..2π from the pad id's hash) so the
  // terminal sits at a stable, per-pad spot on the pad plane's edge.
  const angle =
    new Rng(hash2(seedFromString(pad.padId), seedFromString('terminal'))).nextF64() * 2 * Math.PI;
  const d = Math.max(1, pad.radius - TERMINAL_EDGE_OFFSET_M);
  return {
    x: pad.pos.x + Math.cos(angle) * d,
    y: pad.pos.y, // the pad disc is flat — the terminal stands on it
    z: pad.pos.z + Math.sin(angle) * d,
  };
}

export interface TerminalInfo {
  /** The stable entity id (`terminal:<padId>`). */
  terminalId: string;
  planetId: string;
  padId: string;
  /** World position (on the flat pad disc, at the pad edge). */
  pos: Vec3;
}

/**
 * The deterministic terminal list of a system: exactly one per pad (one
 * per landable planet), in the pads' order. Pure; the shard spawns each as
 * a static 'terminal' entity and the client derives the same positions for
 * rendering.
 */
export function terminalsFor(
  galaxySeed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): TerminalInfo[] {
  return padsForSystem(galaxySeed, system).map((pad) => ({
    terminalId: terminalIdFor(pad),
    planetId: pad.planetId,
    padId: pad.padId,
    pos: terminalPosFor(pad),
  }));
}

/** Horizontal (xz-plane) distance from a position to a terminal (m). */
export function terminalDistanceM(pos: Vec3, terminal: TerminalInfo): number {
  return Math.hypot(pos.x - terminal.pos.x, pos.z - terminal.pos.z);
}

/**
 * True when an on-foot position is "at a station": within TERMINAL_RANGE_M
 * of at least one terminal (x AND z, the pad plane is flat so y is not part
 * of the reach). Pure.
 */
export function withinTerminalRange(pos: Vec3, terminals: TerminalInfo[]): boolean {
  return terminals.some((t) => terminalDistanceM(pos, t) <= TERMINAL_RANGE_M);
}
