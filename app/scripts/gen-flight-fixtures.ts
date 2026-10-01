/**
 * Regenerates the TASK-22 golden trajectory fixtures:
 *   src/shared/physics/__fixtures__/flight-space-60s.json
 *   src/shared/physics/__fixtures__/flight-atmo-30s.json
 *
 * Run: npm run snapshot:update:flight   (or: npx tsx scripts/gen-flight-fixtures.ts)
 *
 * Scenario A — 60 s space flight, constant inputs, fixed dt = 1/20 s:
 * verifies the pure Newtonian path (thrust, rotation, soft speed cap).
 *
 * Scenario B — 30 s atmosphere descent onto a pad: the ship drops under
 * gravity + quadratic drag onto flat terrain and ends settled on the pad
 * at the origin (onPad set). The 1 km boundary ramp is NOT crossed here
 * (density is low-altitude terrain); boundary continuity is tested
 * directly in flight.test.ts.
 *
 * Fixtures are deterministic: regenerate and diff — any drift in
 * flight.ts/vec.ts surfaces as a changed fixture.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ATMOSPHERE_BOUNDARY_M } from '../src/shared/physics/atmosphere';
import {
  GRAVITY,
  integrateShip,
  restShipState,
  type FlightOptions,
  type PlanetAtmo,
  type ShipInput,
  type ShipState,
} from '../src/shared/physics/flight';

const DT = 1 / 20;
const OUT_DIR = join(__dirname, '..', 'src', 'shared', 'physics', '__fixtures__');

interface Fixture {
  scenario: string;
  dt: number;
  steps: number;
  shipClass: string;
  planet: PlanetAtmo | null;
  initial: ShipState;
  input: ShipInput;
  heightAt: { kind: 'flat' | 'slope'; value: number };
  pads: Array<{ id: string; x: number; z: number }>;
  /** State sampled every SAMPLE_EVERY steps (includes the final step). */
  sampleEvery: number;
  samples: Array<{ t: number; state: ShipState }>;
}

function sampleEvery(): number {
  return 20; // 1 s between samples
}

function run(opts: {
  initial: ShipState;
  input: ShipInput;
  dt: number;
  steps: number;
  planet: PlanetAtmo | null;
  shipClass: string;
  heightAt: (x: number, z: number) => number;
  pads?: FlightOptions['pads'];
}): Array<{ t: number; state: ShipState }> {
  const every = sampleEvery();
  let s = opts.initial;
  const out: Array<{ t: number; state: ShipState }> = [];
  for (let i = 1; i <= opts.steps; i++) {
    s = integrateShip(
      s,
      opts.input,
      opts.dt,
      opts.initial.regime,
      opts.planet ?? undefined,
      opts.shipClass,
      { heightAt: opts.heightAt, pads: opts.pads },
    );
    if (i % every === 0 || i === opts.steps) {
      out.push({ t: i * opts.dt, state: s });
    }
  }
  return out;
}

function writeFixture(name: string, fixture: Fixture): void {
  const path = join(OUT_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${path} (${fixture.samples.length} samples)`);
}

// --- Scenario A: 60 s space flight (constant inputs) ----------------------
const space: Fixture = {
  scenario: 'space-60s',
  dt: DT,
  steps: 1200,
  shipClass: 'scout',
  planet: null,
  initial: restShipState({ x: 0, y: 0, z: 0 }, 'space'),
  input: { thrust: 1, yaw: 0.3, pitch: 0.1, roll: 0, up: 0 },
  heightAt: { kind: 'flat', value: 0 },
  pads: [],
  sampleEvery: sampleEvery(),
  samples: run({
    initial: restShipState({ x: 0, y: 0, z: 0 }, 'space'),
    input: { thrust: 1, yaw: 0.3, pitch: 0.1, roll: 0, up: 0 },
    dt: DT,
    steps: 1200,
    planet: null,
    shipClass: 'scout',
    heightAt: () => 0,
  }),
};

// --- Scenario B: 30 s atmosphere descent onto the pad ---------------------
const flatHeightAt = (): number => 0;
const atmo: Fixture = {
  scenario: 'atmo-descent-30s',
  dt: DT,
  steps: 600,
  shipClass: 'freighter',
  planet: { atmosphereDensity: 0.1, atmosphereRadius: ATMOSPHERE_BOUNDARY_M },
  initial: restShipState({ x: 0, y: 320, z: 0 }, 'atmosphere'),
  input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
  heightAt: { kind: 'flat', value: 0 },
  pads: [{ id: 'pad-0', x: 0, z: 0 }],
  sampleEvery: sampleEvery(),
  samples: run({
    initial: restShipState({ x: 0, y: 320, z: 0 }, 'atmosphere'),
    input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
    dt: DT,
    steps: 600,
    planet: { atmosphereDensity: 0.1, atmosphereRadius: ATMOSPHERE_BOUNDARY_M },
    shipClass: 'freighter',
    heightAt: flatHeightAt,
    pads: [{ id: 'pad-0', x: 0, z: 0 }],
  }),
};

writeFixture('flight-space-60s.json', space);
writeFixture('flight-atmo-30s.json', atmo);

// Sanity print: the descent must end settled on the pad.
const last = atmo.samples[atmo.samples.length - 1].state;
const landed = last.onPad === 'pad-0' && Math.abs(last.vel.y) < 1e-6 && last.pos.y <= 1e-6;
console.log(
  `atmo descent final: pos=${JSON.stringify(last.pos)} onPad=${last.onPad} landed=${landed}`,
);
if (!landed) {
  throw new Error('atmosphere descent fixture did not end on the pad');
}
console.log(`(gravity reference: ${GRAVITY} u/s²)`);
