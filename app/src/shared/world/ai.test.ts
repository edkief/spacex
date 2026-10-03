import { describe, expect, it } from 'vitest';

import { CALLSIGN_PATTERN } from '../callsign';
import { generateSystem } from '../galaxy/system';
import { HEX_COLOR } from '../ships';
import { planetAnchor, planetAtmosphereRadius } from '../galaxy/planets';
import { homeDockPosition } from '../galaxy/dock';
import { PIRATE_CALLSIGNS } from '../ai/names';
import { padsForSystem } from './pads';
import {
  MIN_STATION_DIST_U,
  ROGUE_COUNT_MAX,
  ROGUE_COUNT_MIN,
  ROGUE_PATROL_RADIUS_MAX,
  ROGUE_PATROL_RADIUS_MIN,
  ROGUE_SPAWN_RADIUS_MAX,
  ROGUE_SPAWN_RADIUS_MIN,
  rosterFor,
  __resetRosterCache,
} from './ai';

const SEED = 'rogue-ai-test-seed';

/** Three distinct real systems of one galaxy (different star ids). */
const SYSTEMS = [
  generateSystem(SEED, 'star-a'),
  generateSystem(SEED, 'star-b'),
  generateSystem(SEED, 'star-c'),
];

describe('pirate callsign list (TASK-45 AC)', () => {
  it('has exactly 40 unique names, all passing the 3-16 char callsign contract', () => {
    expect(PIRATE_CALLSIGNS).toHaveLength(40);
    expect(new Set(PIRATE_CALLSIGNS).size).toBe(40);
    for (const name of PIRATE_CALLSIGNS) {
      expect(name, `callsign ${name} must match the pattern`).toMatch(CALLSIGN_PATTERN);
    }
  });
});

describe('rosterFor: seeded per-system rosters (TASK-45 AC)', () => {
  const STAR_IDS = ['star-a', 'star-b', 'star-c'];
  it.each(SYSTEMS.map((s, i) => [s, STAR_IDS[i]] as const))(
    'system %s: deterministic roster (same seed → identical, cache-cold)',
    (system, starId) => {
      __resetRosterCache();
      const a = rosterFor(SEED, system);
      __resetRosterCache();
      // Re-derive from a FRESH generateSystem call + cold cache — the roster
      // must be byte-identical (a pure function of the seed).
      const b = rosterFor(SEED, generateSystem(SEED, starId));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: 6-10 ships, stable aiIds, unique pirate callsigns, valid liveries',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      const roster = rosterFor(SEED, system);
      expect(roster.length).toBeGreaterThanOrEqual(ROGUE_COUNT_MIN);
      expect(roster.length).toBeLessThanOrEqual(ROGUE_COUNT_MAX);
      const callsigns = new Set<string>();
      for (let seq = 0; seq < roster.length; seq++) {
        const e = roster[seq];
        expect(e.aiId).toBe(`ai:${systemId}:${seq}`);
        expect(['scout', 'freighter', 'interceptor']).toContain(e.classId);
        callsigns.add(e.callsign);
        expect(PIRATE_CALLSIGNS).toContain(e.callsign);
        expect(e.callsign).toMatch(CALLSIGN_PATTERN);
        expect(HEX_COLOR.test(e.livery.hull)).toBe(true);
        expect(HEX_COLOR.test(e.livery.accent)).toBe(true);
        expect(HEX_COLOR.test(e.livery.trim)).toBe(true);
      }
      // No duplicates within a roster (40 names ≥ 10 ships).
      expect(callsigns.size).toBe(roster.length);
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: spawnPos 500..3000 u from the star (origin), y=0 plane',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      for (const e of rosterFor(SEED, system)) {
        const r = Math.hypot(e.spawnPos.x, e.spawnPos.z);
        expect(r, e.aiId).toBeGreaterThanOrEqual(ROGUE_SPAWN_RADIUS_MIN);
        expect(r, e.aiId).toBeLessThanOrEqual(ROGUE_SPAWN_RADIUS_MAX);
        expect(e.spawnPos.y, e.aiId).toBe(0);
      }
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: no rogue inside any atmosphere (space-only rogues)',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      for (const e of rosterFor(SEED, system)) {
        system.planets.forEach((planet, index) => {
          const atm = planetAtmosphereRadius(planet);
          if (atm <= 0) return;
          const anchor = planetAnchor(index);
          const d = Math.hypot(e.spawnPos.x - anchor.x, e.spawnPos.z - anchor.z);
          expect(d, `${e.aiId} vs ${planet.id}`).toBeGreaterThan(atm);
        });
      }
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: every spawnPos ≥ 200 u from every station anchor (pads + home dock)',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      const stations = [
        ...padsForSystem(SEED, system).map((pad) => pad.pos),
        homeDockPosition(SEED, systemId),
      ];
      expect(stations.length).toBeGreaterThan(0); // the system has anchors
      for (const e of rosterFor(SEED, system)) {
        for (const s of stations) {
          const d = Math.hypot(e.spawnPos.x - s.x, e.spawnPos.z - s.z);
          expect(d, `${e.aiId} vs station`).toBeGreaterThanOrEqual(MIN_STATION_DIST_U);
        }
      }
    },
  );

  it.each(SYSTEMS.map((s) => s.systemId))(
    '%s: patrol center 100..400 u from spawnPos, radius 200..800 u',
    (systemId) => {
      const system = SYSTEMS.find((s) => s.systemId === systemId)!;
      for (const e of rosterFor(SEED, system)) {
        const d = Math.hypot(e.patrolCenter.x - e.spawnPos.x, e.patrolCenter.z - e.spawnPos.z);
        expect(d, e.aiId).toBeGreaterThanOrEqual(100);
        expect(d, e.aiId).toBeLessThanOrEqual(400);
        expect(e.patrolRadius, e.aiId).toBeGreaterThanOrEqual(ROGUE_PATROL_RADIUS_MIN);
        expect(e.patrolRadius, e.aiId).toBeLessThanOrEqual(ROGUE_PATROL_RADIUS_MAX);
      }
    },
  );
});

describe('rosterFor: class distribution (TASK-45 AC)', () => {
  it('holds the 50/35/15 weights over 100 seeded systems (generous bounds)', () => {
    const counts = { scout: 0, interceptor: 0, freighter: 0 };
    let total = 0;
    __resetRosterCache();
    for (let i = 0; i < 100; i++) {
      const system = generateSystem(SEED, `weight-star-${i}`);
      for (const e of rosterFor(SEED, system)) counts[e.classId] += 1;
      total += rosterFor(SEED, system).length;
    }
    expect(total).toBeGreaterThanOrEqual(100 * ROGUE_COUNT_MIN);
    const scout = counts.scout / total;
    const interceptor = counts.interceptor / total;
    const freighter = counts.freighter / total;
    // n ≈ 800 draws: sd ≈ 0.036 (scout) — ±15 pts is a ~4σ band.
    expect(scout).toBeGreaterThan(0.35);
    expect(scout).toBeLessThan(0.65);
    expect(interceptor).toBeGreaterThan(0.2);
    expect(interceptor).toBeLessThan(0.5);
    expect(freighter).toBeGreaterThan(0);
    expect(freighter).toBeLessThan(0.3);
  });
});
