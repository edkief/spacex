import { Rng, hash2, hex64 } from '../random.ts';
import {
  ATMOSPHERE_DENSITY,
  ATMOSPHERE_TOP_FRACTION,
  DOCK_ID_SALT,
  DOCK_MAX_DOT,
  DOCK_ORBIT_FACTOR,
  DOCK_PLACEMENT_ATTEMPTS,
  DOCK_SALT,
  INNERMOST_ORBIT_JITTER_M,
  INNERMOST_ORBIT_M,
  LAYOUT_SALT,
  ORBIT_GAP_MAX_M,
  ORBIT_GAP_MIN_M,
  PAD_SALT,
  SIM_METRES_PER_KM,
} from './layoutConfig.ts';
import { round3 } from './quantize.ts';
import type { Dock, PlanetAtmosphere, Planet, XYZ } from './types.ts';

/** The planet fields the layout depends on. */
export type LayoutInput = Pick<Planet, 'id' | 'class' | 'radiusKm' | 'dockCount' | 'hasAtmosphere'>;

/** Layout fields added to a planet. */
export interface PlanetLayout {
  simRadius: number;
  orbitRadius: number;
  position: XYZ;
  docks: Dock[];
  atmosphere: PlanetAtmosphere | null;
}

/** Unit direction in the y = 0 plane by rejection-sampling the unit disc (no trig). */
function planarDirection(rng: Rng): XYZ {
  for (;;) {
    const x = rng.nextRange(-1, 1);
    const z = rng.nextRange(-1, 1);
    const squared = x * x + z * z;
    if (squared <= 1 && squared > 1e-9) {
      const length = Math.sqrt(squared);
      return { x: x / length, y: 0, z: z / length };
    }
  }
}

/** Unit direction in 3D by rejection-sampling the unit ball and normalising with sqrt. */
function sphericalDirection(rng: Rng): XYZ {
  for (;;) {
    const x = rng.nextRange(-1, 1);
    const y = rng.nextRange(-1, 1);
    const z = rng.nextRange(-1, 1);
    const squared = x * x + y * y + z * z;
    if (squared <= 1 && squared > 1e-9) {
      const length = Math.sqrt(squared);
      return { x: x / length, y: y / length, z: z / length };
    }
  }
}

/**
 * Places a planet's docks: seeded points 1.6 radii from the planet centre, kept at least ~26
 * degrees apart where possible (a few retries, then accepted anyway so the draw count stays
 * bounded). Each dock has a stable id and one pad id.
 */
function placeDocks(planetSeed: bigint, count: number, center: XYZ, simRadius: number): Dock[] {
  const rng = new Rng(hash2(planetSeed, DOCK_SALT));
  const directions: XYZ[] = [];
  for (let i = 0; i < count; i++) {
    let chosen = sphericalDirection(rng);
    for (let attempt = 1; attempt < DOCK_PLACEMENT_ATTEMPTS; attempt++) {
      const clear = directions.every(
        (d) => d.x * chosen.x + d.y * chosen.y + d.z * chosen.z <= DOCK_MAX_DOT,
      );
      if (clear) break;
      chosen = sphericalDirection(rng);
    }
    directions.push(chosen);
  }
  const orbit = simRadius * DOCK_ORBIT_FACTOR;
  return directions.map((d, index) => {
    const dockSeed = hash2(planetSeed, DOCK_ID_SALT + BigInt(index));
    return {
      id: hex64(dockSeed),
      padId: hex64(hash2(dockSeed, PAD_SALT)),
      position: {
        x: round3(center.x + d.x * orbit),
        y: round3(center.y + d.y * orbit),
        z: round3(center.z + d.z * orbit),
      },
    };
  });
}

/**
 * Generates the layout of a system: orbit radii (innermost ~8,000 km sim, each next 6,000-20,000
 * km further), a seeded direction per planet in the y = 0 plane, docks, and atmosphere
 * parameters. Draws come from fresh sub-seeds, so no existing generated field changes.
 */
export function generateLayout(
  systemSeed: bigint,
  planets: readonly LayoutInput[],
): PlanetLayout[] {
  const rng = new Rng(hash2(systemSeed, LAYOUT_SALT));
  let orbit = INNERMOST_ORBIT_M + rng.nextRange(0, INNERMOST_ORBIT_JITTER_M);
  return planets.map((planet, index) => {
    if (index > 0) orbit += rng.nextRange(ORBIT_GAP_MIN_M, ORBIT_GAP_MAX_M);
    const direction = planarDirection(rng);
    const orbitRadius = round3(orbit);
    const position = { x: round3(direction.x * orbit), y: 0, z: round3(direction.z * orbit) };
    const simRadius = planet.radiusKm * SIM_METRES_PER_KM;
    return {
      simRadius,
      orbitRadius,
      position,
      docks: placeDocks(BigInt(`0x${planet.id}`), planet.dockCount, position, simRadius),
      atmosphere: planet.hasAtmosphere
        ? { density: ATMOSPHERE_DENSITY[planet.class], topFraction: ATMOSPHERE_TOP_FRACTION }
        : null,
    };
  });
}
