import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import type { SystemGen } from '@shared/galaxy/types';
import { systemRegimePlanets } from '@shared/galaxy/planets';
import type { RegimePlanet } from '@shared/regime';
import { vec } from '@shared/physics/vec';
import type { EntityState, FlightRegime } from '@shared/protocol/schemas';

import { RegimeWiring } from './regime-wiring';

const SEED = 'TEST-SEED-25-2';

/**
 * Deterministic fixtures: the first star whose system has an atmosphere
 * planet, plus any other system (for the setSystem reset check).
 */
function fixtureSystems(): {
  withAtmosphere: { system: SystemGen; planet: RegimePlanet };
  other: SystemGen;
} {
  let withAtmosphere: { system: SystemGen; planet: RegimePlanet } | null = null;
  let other: SystemGen | null = null;
  for (const star of generateStars(SEED)) {
    const system = generateSystem(SEED, star.id);
    if (!withAtmosphere) {
      const planet = systemRegimePlanets(system).find((p) => p.atmosphereRadius > 0);
      if (planet) withAtmosphere = { system, planet };
    } else if (!other && system.systemId !== withAtmosphere.system.systemId) {
      other = system;
    }
    if (withAtmosphere && other) break;
  }
  if (!withAtmosphere || !other) throw new Error(`seed ${SEED} has no suitable fixture systems`);
  return { withAtmosphere, other };
}

const FIXTURE = fixtureSystems();
const ATMO_SYSTEM = FIXTURE.withAtmosphere.system;
const ATMO_PLANET = FIXTURE.withAtmosphere.planet;
const OTHER_SYSTEM = FIXTURE.other;
/** 50 u above the atmosphere planet's flat client-side ground: inside, not surface-eligible. */
const IN_ATMOSPHERE = vec(ATMO_PLANET.x, 50, ATMO_PLANET.z);
/** Far from every planet anchor (10 km spacing): always space locally. */
const FAR_AWAY = vec(1_000_000, 0, 0);

function selfEntity(
  pos: { x: number; y: number; z: number },
  flightRegime?: FlightRegime,
): EntityState {
  return {
    id: 'ship-self',
    kind: 'ship',
    pos,
    vel: vec(0, 0, 0),
    regime: 'sublight',
    flightRegime,
    hull: 1,
    shields: 1,
    targetId: null,
    classId: 'scout',
    callsign: 'TESTPILOT',
  };
}

describe('RegimeWiring (session → tracker + remapper)', () => {
  it('self entity_update with flightRegime "atmosphere" flips the active scheme space→atmosphere with no divergence warning', () => {
    const warns: string[] = [];
    const logs: string[] = [];
    const wiring = new RegimeWiring({
      warn: (m) => warns.push(m),
      log: (m) => logs.push(m),
    });
    wiring.setSystem(SEED, ATMO_SYSTEM.systemId);
    expect(wiring.regime).toBe('space');
    expect(wiring.remapper.regime).toBe('space');

    // First self snapshot arrives inside the atmosphere (local prediction
    // agrees with the server: no divergence, no warning).
    wiring.onSelfUpdate(selfEntity(IN_ATMOSPHERE, 'atmosphere'), 1000);
    expect(wiring.regime).toBe('atmosphere');
    expect(wiring.remapper.regime).toBe('atmosphere');
    expect(logs).toEqual(['controls remap']); // exactly one scheme swap
    expect(warns.length).toBe(0);

    // Further self updates keep the scheme (no duplicate swaps, no warns).
    wiring.onSelfUpdate(selfEntity(IN_ATMOSPHERE, 'atmosphere'), 1100);
    wiring.onSelfUpdate(selfEntity(IN_ATMOSPHERE, 'atmosphere'), 1200);
    expect(wiring.remapper.regime).toBe('atmosphere');
    expect(logs.length).toBe(1);
    expect(warns.length).toBe(0);
  });

  it('a system change (setSystem) resets the tracker and remap back to space', () => {
    const logs: string[] = [];
    const wiring = new RegimeWiring({ log: (m) => logs.push(m) });
    wiring.setSystem(SEED, ATMO_SYSTEM.systemId);
    wiring.onSelfUpdate(selfEntity(IN_ATMOSPHERE, 'atmosphere'), 1000);
    expect(wiring.remapper.regime).toBe('atmosphere');

    wiring.setSystem(SEED, OTHER_SYSTEM.systemId);
    expect(wiring.regime).toBe('space');
    expect(wiring.remapper.regime).toBe('space');
    expect(logs).toEqual(['controls remap', 'controls remap']); // swap in, reset out
  });

  it('a missing flightRegime (v1 back-compat) is no authority: local prediction drives, then the 500 ms rule applies', () => {
    const warns: string[] = [];
    const wiring = new RegimeWiring({ warn: (m) => warns.push(m) });
    wiring.setSystem(SEED, ATMO_SYSTEM.systemId);
    wiring.onSelfUpdate(selfEntity(FAR_AWAY), 0); // no flightRegime: local space
    expect(wiring.regime).toBe('space');

    // Authority arrives (space vs atmosphere — a genuine divergence):
    // under the tolerance the local prediction stays active…
    wiring.onSelfUpdate(selfEntity(FAR_AWAY, 'atmosphere'), 100);
    expect(wiring.remapper.regime).toBe('space');
    expect(warns.length).toBe(0);
    // …and past 500 ms the tracker snaps to the server with a warning.
    wiring.onSelfUpdate(selfEntity(FAR_AWAY, 'atmosphere'), 700);
    expect(wiring.regime).toBe('atmosphere');
    expect(wiring.remapper.regime).toBe('atmosphere');
    expect(warns.length).toBe(1);
  });
});
