import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateStars } from './stars';
import { generateSystem } from './system';
import { generateSurfaceChunk } from './surface';
import { canonicalJson, canonicalize } from '../canonical';
import { Planet } from './types';

const SEED = 'dev-seed';
const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

function getChecksum(data: any): string {
  const canonical = JSON.stringify(canonicalize(data));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function run() {
  console.log(`Updating snapshots for seed: ${SEED}...`);

  // 1. Star Chart
  const stars = generateStars(SEED);
  const starChart = {
    first25: stars.slice(0, 25),
    totalCount: stars.length,
    checksum: getChecksum(stars)
  };
  
  fs.writeFileSync(path.join(FIXTURES_DIR, 'stars-dev-seed.json'), canonicalJson(starChart));
  console.log('Saved stars-dev-seed.json');

  // 2. System of star #0
  const star0 = stars[0];
  const system0 = generateSystem(SEED, star0.id);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'system-star-0.json'), canonicalJson(system0));
  console.log('Saved system-star-0.json');

  // 3. System of star #1
  const star1 = stars[1];
  const system1 = generateSystem(SEED, star1.id);
  fs.writeFileSync(path.join(FIXTURES_DIR, 'system-star-1.json'), canonicalJson(system1));
  console.log('Saved system-star-1.json');

  // 4. Surface Chunks of first landable planet
  let firstLandablePlanet: Planet | null = null;
  for (const star of stars) {
    const sys = generateSystem(SEED, star.id);
    const landable = sys.planets.find(p => p.landable);
    if (landable) {
      firstLandablePlanet = landable;
      break;
    }
  }

  if (firstLandablePlanet) {
    const chunks = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
    ];
    for (const { x, z } of chunks) {
      const chunk = generateSurfaceChunk(SEED, firstLandablePlanet, x, z);
      fs.writeFileSync(path.join(FIXTURES_DIR, `chunk-${x}-${z}.json`), canonicalJson(chunk));
      console.log(`Saved chunk-${x}-${z}.json`);
    }
  } else {
    console.error('No landable planet found!');
  }

  console.log('Snapshots updated successfully.');
}

run().catch(console.error);
