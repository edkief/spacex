import { describe, expect, it } from 'vitest';

import type { Planet, SystemGen } from '../galaxy/types';
import {
  TERMINAL_EDGE_OFFSET_M,
  TERMINAL_RANGE_M,
  terminalDistanceM,
  terminalIdFor,
  terminalPosFor,
  terminalsFor,
  withinTerminalRange,
} from './terminals';
import { padsForSystem } from './pads';

/**
 * TASK-40 step 4: the station terminal geometry (shared/world/terminals.ts).
 * The terminal is one per pad, DERIVED deterministically (never stored —
 * PRD §6), standing on the flat pad disc at the pad edge:
 * - terminalsFor: exactly one terminal per pad (one per landable planet),
 *   in the pads' order;
 * - terminalPosFor: on the pad plane (y = the pad height) at a deterministic
 *   per-pad angle, distance (radius − edge offset) from the pad center;
 * - withinTerminalRange: the on-foot "at a station" reach (≤ 10 m, xz only —
 *   the pad plane is flat so altitude is not part of the reach).
 */

const SEED = 'TERMINAL-UNIT-SEED';

function makePlanet(id: string): Planet {
  return {
    id,
    name: id,
    class: 'terran',
    radiusKm: 3000,
    hasAtmosphere: true,
    landable: true,
    dockCount: 1,
    resourceTypes: ['iron'],
    aiRoster: { count: 1, classes: ['scout'] },
  };
}

const SYSTEM: SystemGen = {
  systemId: 'sys-terminal-sim',
  name: 'Terminal system',
  star: { class: 'G', name: 'Varda' },
  planets: [
    makePlanet('planet-a'),
    makePlanet('planet-b'),
    { ...makePlanet('planet-x'), landable: false },
  ],
};

describe('terminalsFor — one per pad, deterministic', () => {
  it('spawns exactly one terminal per LANDABLE planet, in the pads order', () => {
    const pads = padsForSystem(SEED, SYSTEM);
    const terminals = terminalsFor(SEED, SYSTEM);
    expect(pads).toHaveLength(2); // the non-landable planet has no pad
    expect(terminals).toHaveLength(2);
    terminals.forEach((t, i) => {
      expect(t.planetId).toBe(pads[i].planetId);
      expect(t.padId).toBe(pads[i].padId);
      expect(t.terminalId).toBe(terminalIdFor(pads[i]));
    });
  });

  it('is stable across calls (the same derivation both sides rely on)', () => {
    expect(terminalsFor(SEED, SYSTEM)).toEqual(terminalsFor(SEED, SYSTEM));
  });
});

describe('terminalPosFor — on the pad plane, at the pad edge', () => {
  it('stands on the flat pad disc (y = pad height) at radius − edge offset from center', () => {
    for (const pad of padsForSystem(SEED, SYSTEM)) {
      const pos = terminalPosFor(pad);
      expect(pos.y).toBe(pad.pos.y); // the pad disc is flat
      const dist = Math.hypot(pos.x - pad.pos.x, pos.z - pad.pos.z);
      expect(dist).toBeCloseTo(pad.radius - TERMINAL_EDGE_OFFSET_M, 6);
    }
  });

  it('is a deterministic, per-pad angle (two pads → two distinct spots)', () => {
    const [padA, padB] = padsForSystem(SEED, SYSTEM);
    const a = terminalPosFor(padA);
    const b = terminalPosFor(padB);
    expect(a.x).not.toBeCloseTo(padA.pos.x, 3); // not dead-center
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0); // distinct positions
  });
});

describe('withinTerminalRange — the on-foot "at a station" reach', () => {
  it('is true within 10 m (xz) and false beyond', () => {
    const [pad] = padsForSystem(SEED, SYSTEM);
    const t = {
      terminalId: terminalIdFor(pad),
      planetId: pad.planetId,
      padId: pad.padId,
      pos: terminalPosFor(pad),
    };
    const at = (dx: number, dz: number) =>
      withinTerminalRange({ x: t.pos.x + dx, y: t.pos.y, z: t.pos.z + dz }, [t]);
    expect(at(0, 0)).toBe(true);
    expect(at(TERMINAL_RANGE_M, 0)).toBe(true); // exactly at the range edge
    expect(at(TERMINAL_RANGE_M + 0.5, 0)).toBe(false); // just outside
    expect(at(6, 8)).toBe(true); // hypot(6,8) = 10 → on the boundary
    expect(at(7, 8)).toBe(false); // hypot(7,8) ≈ 10.63 → outside
  });

  it('ignores altitude (the pad plane is flat — y is not part of the reach)', () => {
    const [pad] = padsForSystem(SEED, SYSTEM);
    const t = {
      terminalId: terminalIdFor(pad),
      planetId: pad.planetId,
      padId: pad.padId,
      pos: terminalPosFor(pad),
    };
    const sameXzHighY = { x: t.pos.x, y: t.pos.y + 50, z: t.pos.z };
    expect(withinTerminalRange(sameXzHighY, [t])).toBe(true);
    expect(terminalDistanceM(t.pos, t)).toBe(0);
  });
});
