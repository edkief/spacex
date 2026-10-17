/**
 * One-off script: regenerate `src/shared/physics/__fixtures__/trajectories.ts`
 * from the current flight model. Run with `npx tsx scripts/gen-flight-trajectories.ts`
 * when the physics integration changes *and* you have updated the
 * snapshot test.
 *
 * Records:
 *   - 60 s of straight-line space flight (full thrust, no rotation),
 *     integrator at 20 Hz.
 *   - 30 s of atmosphere descent from altitude (mild drag, partial
 *     VTOL lift, pads in view).
 *
 * The final state of each integration is committed as the golden
 * fixture; the test re-runs the same integration and asserts the
 * result matches to within 1e-9 per axis (determinism tolerance).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shipStats } from "../src/shared/ships.js";
import { makeFlatPlanet } from "../src/shared/physics/atmosphere.js";
import { IDENTITY, type Vec3 } from "../src/shared/physics/vec.js";
import {
  integrateShip,
  type FlightPad,
  type ShipInput,
  type ShipState,
} from "../src/shared/physics/flight.js";

const HZ = 20;
const DT = 1 / HZ;

interface FixtureRecord {
  readonly name: string;
  readonly shipClass: string;
  readonly seconds: number;
  readonly start: ShipState;
  readonly input: ShipInput;
  readonly planet?: ReturnType<typeof makeFlatPlanet> & {
    readonly pads?: readonly FlightPad[];
  };
  readonly final: ShipState;
}

function runFixture(
  start: ShipState,
  input: ShipInput,
  regime: "space" | "atmosphere",
  seconds: number,
  planet?: FixtureRecord["planet"],
): ShipState {
  let cur = start;
  const steps = Math.round(seconds * HZ);
  for (let i = 0; i < steps; i++) {
    cur = integrateShip(cur, input, DT, regime, shipStats("scout"), planet);
  }
  return cur;
}

const ZERO_VEL: Vec3 = { x: 0, y: 0, z: 0 };

// ----- 60s space flight -----------------------------------------------------
const spaceStart: ShipState = {
  pos: { x: 0, y: 0, z: 0 },
  vel: { ...ZERO_VEL },
  quat: { ...IDENTITY },
  regime: "space",
};
const spaceInput: ShipInput = {
  thrust: 1,
  yaw: 0,
  pitch: 0,
  roll: 0,
  up: 0,
};
const spaceFinal = runFixture(spaceStart, spaceInput, "space", 60);

// ----- 30s atmosphere descent ---------------------------------------------
const pads: readonly FlightPad[] = [{ id: "pad-home", x: 0, z: 0, height: 0, radius: 20 }];
const atmoPlanet = makeFlatPlanet({
  id: "test-planet",
  radius: 1_000_000,
  atmosphereDensity: 0.01,
  atmosphereHeight: 10_000,
  hasAtmosphere: true,
});
// makeFlatPlanet doesn't accept pads; we attach them on top.
const atmoPlanetWithPads = {
  ...atmoPlanet,
  pads,
};

const atmoStart: ShipState = {
  pos: { x: 0, y: 1_000_000 + 3000, z: 0 }, // 3 km above surface
  vel: { x: 0, y: -20, z: 0 }, // gentle descent
  quat: { ...IDENTITY },
  regime: "atmosphere",
};
const atmoInput: ShipInput = {
  thrust: 0.4,
  yaw: 0,
  pitch: 0,
  roll: 0,
  up: 0.2, // light VTOL lift to soften the descent
};
const atmoFinal = runFixture(atmoStart, atmoInput, "atmosphere", 30, atmoPlanetWithPads);

const spaceRecord: FixtureRecord = {
  name: "space-60s",
  shipClass: "scout",
  seconds: 60,
  start: spaceStart,
  input: spaceInput,
  final: spaceFinal,
};

const atmoRecord: FixtureRecord = {
  name: "atmo-30s",
  shipClass: "scout",
  seconds: 30,
  start: atmoStart,
  input: atmoInput,
  planet: atmoPlanetWithPads,
  final: atmoFinal,
};

// ----- emit as a TS module so it gets type-checked by the test file -------

function fmtVec(v: Vec3): string {
  return `{ x: ${v.x}, y: ${v.y}, z: ${v.z} }`;
}

function fmtQuat(q: { x: number; y: number; z: number; w: number }): string {
  return `{ x: ${q.x}, y: ${q.y}, z: ${q.z}, w: ${q.w} }`;
}

function emitRecord(r: FixtureRecord): string {
  const lines: string[] = [];
  lines.push(`  {`);
  lines.push(`    name: ${JSON.stringify(r.name)},`);
  lines.push(`    shipClass: ${JSON.stringify(r.shipClass)},`);
  lines.push(`    seconds: ${r.seconds},`);
  lines.push(`    start: {`);
  lines.push(`      pos: ${fmtVec(r.start.pos)},`);
  lines.push(`      vel: ${fmtVec(r.start.vel)},`);
  lines.push(`      quat: ${fmtQuat(r.start.quat)},`);
  lines.push(`      regime: ${JSON.stringify(r.start.regime)},`);
  lines.push(`    },`);
  lines.push(`    input: {`);
  lines.push(`      thrust: ${r.input.thrust},`);
  lines.push(`      yaw: ${r.input.yaw},`);
  lines.push(`      pitch: ${r.input.pitch},`);
  lines.push(`      roll: ${r.input.roll},`);
  lines.push(`      up: ${r.input.up},`);
  lines.push(`    },`);
  if (r.planet) {
    lines.push(`    planet: {`);
    lines.push(`      id: ${JSON.stringify(r.planet.id)},`);
    lines.push(`      radius: ${r.planet.radius},`);
    lines.push(`      atmosphereHeight: ${r.planet.atmosphereHeight},`);
    lines.push(`      atmosphereDensity: ${r.planet.atmosphereDensity},`);
    lines.push(`      hasAtmosphere: ${r.planet.hasAtmosphere},`);
    lines.push(`      heightAt: (_x: number, _z: number): number => 0,`);
    if (r.planet.pads) {
      lines.push(`      pads: [`);
      for (const pad of r.planet.pads) {
        lines.push(
          `        { id: ${JSON.stringify(pad.id)}, x: ${pad.x}, z: ${pad.z}, height: ${pad.height}, radius: ${pad.radius} },`,
        );
      }
      lines.push(`      ],`);
    }
    lines.push(`    },`);
  }
  lines.push(`    final: {`);
  lines.push(`      pos: ${fmtVec(r.final.pos)},`);
  lines.push(`      vel: ${fmtVec(r.final.vel)},`);
  lines.push(`      quat: ${fmtQuat(r.final.quat)},`);
  lines.push(`      regime: ${JSON.stringify(r.final.regime)},`);
  lines.push(
    `      onPad: ${r.final.onPad === undefined ? "undefined" : JSON.stringify(r.final.onPad)},`,
  );
  lines.push(`    },`);
  lines.push(`  };`);
  return lines.join("\n");
}

const header = `/**
 * AUTO-GENERATED — do not hand-edit.
 *
 * Regenerate with: npx tsx scripts/gen-flight-trajectories.ts
 *
 * Two golden trajectories that prove the flight model is bit-stable
 * across runs and clients. See flight.test.ts > "golden trajectory
 * fixtures" for the acceptance check.
 */
import type { ShipInput, ShipState } from "../flight.js";
import type { PlanetAtmosphere } from "../atmosphere.js";
import type { FlightPad } from "../flight.js";

export interface GoldenTrajectory {
  readonly name: string;
  readonly shipClass: string;
  readonly seconds: number;
  readonly start: ShipState;
  readonly input: ShipInput;
  readonly planet?: PlanetAtmosphere & { readonly pads?: readonly FlightPad[] };
  readonly final: ShipState;
}

// Marker export — keeps the module non-empty when consumed via
// \`import {} from "./trajectories.js"\` style imports.
export const _unused_marker = true;

`;

const source =
  header +
  `export const GOLDEN_SPACE_60S: GoldenTrajectory =\n` +
  emitRecord(spaceRecord) +
  "\n" +
  `export const GOLDEN_ATMO_30S: GoldenTrajectory =\n` +
  emitRecord(atmoRecord) +
  "\n";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src/shared/physics/__fixtures__/trajectories.ts");
writeFileSync(out, source, "utf8");
console.info(`Wrote flight trajectory fixtures → ${out}`);
console.info(`  space-60s final.pos = ${fmtVec(spaceFinal.pos)}`);
console.info(`  space-60s final.vel = ${fmtVec(spaceFinal.vel)}`);
console.info(`  atmo-30s  final.pos = ${fmtVec(atmoFinal.pos)}`);
console.info(`  atmo-30s  final.vel = ${fmtVec(atmoFinal.vel)}`);
console.info(`  atmo-30s  final.onPad = ${atmoFinal.onPad ?? "undefined"}`);
