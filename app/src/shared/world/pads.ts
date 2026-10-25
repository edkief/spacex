import { Vec3 } from '../physics/vec';
import { generateSystem } from '../galaxy/system';
import { generateSurfaceChunk } from '../galaxy/surface';
import { planetWorldPosition, STAR_SYSTEM_OFFSET_M } from '../galaxy/regime-planets';
import { seedFromString, hash2, Rng } from '../random';

export interface Pad {
  id: string;
  pos: Vec3;
  normal: Vec3;
  radius: number;
}

/**
 * Deterministically derives all landing pads for a given system.
 * This includes one pad for each landable planet (at its primary settlement)
 * and one pad for the system's space station.
 */
export function padsFor(seed: string, starId: string): Pad[] {
  const system = generateSystem(seed, starId);
  const pads: Pad[] = [];

  // 1. Planetary Settlement Pads
  // Each landable planet has exactly one primary settlement at chunk (0,0)
  system.planets.forEach((planet, i) => {
    if (!planet.landable) return;

    const planetPos = planetWorldPosition(seed, starId, i);
    const chunk = generateSurfaceChunk(seed, planet, 0, 0);
    const pad = chunk.landingPads[0];

    if (pad) {
      const radiusM = planet.radiusKm * 1000;
      
      // Use the height from the heightmap at the pad's local position
      const height = chunk.heightmap[pad.z * 64 + pad.x];

      // We simplify the pad's world position by placing it "up" from the planet center.
      // In a full implementation, this would be correctly mapped to the sphere's surface.
      pads.push({
        id: `pad-planet-${planet.id}`,
        pos: { 
          x: planetPos.x, 
          y: planetPos.y + (radiusM + height), 
          z: planetPos.z 
        },
        normal: { x: 0, y: 1, z: 0 },
        radius: 20,
      });
    }
  });

  // 2. Station Pad
  // Generate one deterministic space station per system.
  const masterSeed = seedFromString(seed);
  const starSeed = seedFromString(starId);
  const systemSeed = hash2(masterSeed, starSeed);
  const rng = new Rng(systemSeed);
  
  // Position the station at a deterministic distance from the star
  const dist = 2000 + rng.nextInt(3000);
  const angle = rng.nextF64() * Math.PI * 2;
  
  pads.push({
    id: `pad-station-${systemSeed.toString(16)}`,
    pos: {
      x: Math.cos(angle) * dist,
      y: (rng.nextF64() - 0.5) * 1000,
      z: Math.sin(angle) * dist + STAR_SYSTEM_OFFSET_M,
    },
    normal: { x: 0, y: 1, z: 0 },
    radius: 20,
  });

  return pads;
}
