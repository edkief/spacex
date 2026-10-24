import { Planet } from './types';
import { Rng, seedFromString, hash2 } from '../random';

export type Biome = 'plains' | 'rock' | 'canyon' | 'frozen' | 'wetland';

export interface ResourceNode {
  nodeId: string;
  type: string;
  x: number;
  z: number;
  baseQuantity: number;
}

export interface LandingPad {
  id: string;
  x: number;
  z: number;
}

export interface SurfaceChunk {
  chunkX: number;
  chunkZ: number;
  heightmap: number[];
  biome: Biome;
  resourceNodes: ResourceNode[];
  landingPads: LandingPad[];
}

/**
 * Interpolation helpers
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic 2D Value Noise
 * Lattice size is 32 units.
 */
function valueNoise2D(x: number, z: number, seed: bigint): number {
  const latticeSize = 32;
  const xi = Math.floor(x / latticeSize);
  const zi = Math.floor(z / latticeSize);
  const xf = x / latticeSize - xi;
  const zf = z / latticeSize - zi;

  const ux = smoothstep(xf);
  const uz = smoothstep(zf);

  const getSample = (ix: number, iz: number) => {
    // Combine ix and iz into a single seed for hash2
    // Using a simple shift and or for coordinates
    const coordHash = (BigInt(ix) << 32n) | (BigInt(iz) & 0xffffffffn);
    const h = hash2(seed, coordHash);
    // Map bigint to [0, 1)
    // MASK64 is probably 0xFFFFFFFFFFFFFFFFn from random.ts
    return Number(h & 0x7fffffffffffffffn) / 0x8000000000000000;
  };

  const v00 = getSample(xi, zi);
  const v10 = getSample(xi + 1, zi);
  const v01 = getSample(xi, zi + 1);
  const v11 = getSample(xi + 1, zi + 1);

  const nx0 = lerp(v00, v10, ux);
  const nx1 = lerp(v01, v11, ux);

  return lerp(nx0, nx1, uz);
}

/**
 * Fractional Brownian Motion (fBm)
 * Sums multiple octaves of noise to create a more natural terrain.
 */
function fBm(x: number, z: number, seed: bigint, octaves: number = 4): number {
  let total = 0;
  let frequency = 1;
  let amplitude = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    total += valueNoise2D(x * frequency, z * frequency, seed) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return total / maxValue;
}

/**
 * Deterministically generates a surface chunk for a planet.
 */
export function generateSurfaceChunk(
  seed: string,
  planet: Planet,
  chunkX: number,
  chunkZ: number,
): SurfaceChunk {
  const masterSeed = seedFromString(seed);
  const planetSeed = hash2(masterSeed, BigInt(planet.id.replace('p-', '')));

  // Use a separate seed for the chunk's PRNG to handle placement
  const chunkSeed = hash2(planetSeed, (BigInt(chunkX) << 32n) | (BigInt(chunkZ) & 0xffffffffn));
  const rng = new Rng(chunkSeed);

  // 1. Generate Heightmap (64x64)
  // Height = fBm scaled by radiusKm/1000 (roughly) or a fixed scale.
  // Let's use a scale of 100m for height variance.
  const heightmap: number[] = [];
  const heightScale = 100;
  const moistureSeed = hash2(planetSeed, 0xdeadbeefn);

  let avgHeight = 0;
  let avgMoisture = 0;

  for (let z = 0; z < 64; z++) {
    for (let x = 0; x < 64; x++) {
      const worldX = chunkX * 64 + x;
      const worldZ = chunkZ * 64 + z;

      const h = fBm(worldX, worldZ, planetSeed);
      const m = fBm(worldX, worldZ, moistureSeed);

      heightmap.push(Math.floor(h * heightScale));
      avgHeight += h;
      avgMoisture += m;
    }
  }

  // 2. Determine Biome based on average height and moisture
  const finalAvgHeight = avgHeight / (64 * 64);
  const finalAvgMoisture = avgMoisture / (64 * 64);

  let biome: Biome = 'plains';
  if (finalAvgHeight < 0.3) {
    biome = finalAvgMoisture > 0.5 ? 'wetland' : 'canyon';
  } else if (finalAvgHeight > 0.7) {
    biome = 'rock';
  } else if (finalAvgMoisture < 0.3) {
    biome = 'frozen';
  }

  // 3. Resource Node Placement
  const resourceNodes: ResourceNode[] = [];
  const nodeCount = rng.nextInt(4) + 1; // 1-4 nodes

  for (let i = 0; i < nodeCount; i++) {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 10) {
      attempts++;
      const nx = rng.nextInt(64);
      const nz = rng.nextInt(64);

      // Avoid 'wetland' for solid resources (simplified: just a probability)
      if (biome === 'wetland' && rng.nextF64() < 0.5) continue;

      const type = rng.pick(planet.resourceTypes);
      const quantity = Math.floor(rng.nextRange(50, 200));

      // nodeId = hex hash of (seed, planetId, chunkX, chunkZ, nodeIndex)
      const nodeSeed = hash2(chunkSeed, BigInt(i));
      const nodeId = `node-${nodeSeed.toString(16)}`;

      resourceNodes.push({
        nodeId,
        type,
        x: nx,
        z: nz,
        baseQuantity: quantity,
      });
      placed = true;
    }
  }

  // 4. Landing Pad Placement
  const landingPads: LandingPad[] = [];

  // Special case: chunk (0,0) of a landable planet always has 1 pad
  const isOrigin = chunkX === 0 && chunkZ === 0;
  const padProbability = 0.25;

  if ((isOrigin && planet.landable) || (!isOrigin && rng.nextF64() < padProbability)) {
    // Find a flat area: sample a few spots and pick the one with lowest gradient
    let bestX = 0;
    let bestZ = 0;
    let minGradient = Infinity;

    for (let i = 0; i < 5; i++) {
      const tx = rng.nextInt(62) + 1;
      const tz = rng.nextInt(62) + 1;

      // Gradient check: diff between neighbors
      const h = heightmap[tz * 64 + tx];
      const dx = Math.abs(h - heightmap[tz * 64 + tx + 1]);
      const dz = Math.abs(h - heightmap[(tz + 1) * 64 + tx]);
      const gradient = dx + dz;

      if (gradient < minGradient) {
        minGradient = gradient;
        bestX = tx;
        bestZ = tz;
      }
    }

    landingPads.push({
      id: `pad-${hash2(chunkSeed, 0xdeadbeefn).toString(16)}`,
      x: bestX,
      z: bestZ,
    });
  }

  return {
    chunkX,
    chunkZ,
    heightmap,
    biome,
    resourceNodes,
    landingPads,
  };
}
