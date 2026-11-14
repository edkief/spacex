import type { Body } from '@shared/physics/bodies.ts';
import type { FlightWorld, ShipState } from '@shared/physics/flightTypes.ts';
import { stepShip } from '@shared/physics/stepShip.ts';
import { body, IDLE, NORTH, restingShip } from '@shared/physics/testkit.ts';
import { shipStats } from '@shared/ships/catalog.ts';

/** One recorded sample of a golden trajectory (rounded to 1e-6 so the fixture is stable text). */
export interface Sample {
  t: number;
  frame: string;
  regime: string;
  onPad: string | null;
  pos: [number, number, number];
  vel: [number, number, number];
  quat: [number, number, number, number];
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;

function sample(t: number, s: ShipState): Sample {
  return {
    t: round(t),
    frame: s.frame === 'system' ? 'system' : 'planet',
    regime: s.regime,
    onPad: s.onPad ?? null,
    pos: [round(s.pos.x), round(s.pos.y), round(s.pos.z)],
    vel: [round(s.vel.x), round(s.vel.y), round(s.vel.z)],
    quat: [round(s.quat.x), round(s.quat.y), round(s.quat.z), round(s.quat.w)],
  };
}

/** Wavy analytic terrain used by the descent fixture: 100 m +- a few metres. */
export const goldenHeight = (x: number, z: number): number =>
  100 + 3 * Math.sin(x / 37) + 2 * Math.cos(z / 29);

/** 60 s of scripted open-space flight in a scout (dt = 1/20 s), sampled every 5 s. */
export function spaceTrajectory(): Sample[] {
  const far: Body = { ...body, center: { x: 2e9, y: 0, z: 0 } };
  const world: FlightWorld = { bodies: [far], surface: () => undefined };
  const cls = shipStats('scout');
  let s = restingShip({ x: 0, y: 0, z: 0 });
  const samples = [sample(0, s)];
  for (let step = 1; step <= 1200; step++) {
    const t = step * 0.05;
    const input =
      t <= 20
        ? { ...IDLE, thrust: 1, yaw: 0.2 }
        : t <= 40
          ? { ...IDLE, thrust: 0.5, pitch: 0.3, roll: 0.2, up: 0.1 }
          : { ...IDLE, brake: true, yaw: -0.1 };
    s = stepShip(s, input, 0.05, world, cls);
    if (step % 100 === 0) samples.push(sample(t, s));
  }
  return samples;
}

/** 30 s idle descent onto a pad (dt = 1/20 s): hover-assist sink, touchdown, onPad; every 2.5 s. */
export function descentTrajectory(): Sample[] {
  const world: FlightWorld = {
    bodies: [body],
    surface: () => ({ heightAt: goldenHeight, pads: [{ id: 'golden-pad', x: 0, z: 0 }] }),
  };
  const cls = shipStats('scout');
  let s = restingShip({ x: 5, y: 190, z: 2 }, { frame: NORTH, regime: 'atmosphere' });
  const samples = [sample(0, s)];
  for (let step = 1; step <= 600; step++) {
    s = stepShip(s, IDLE, 0.05, world, cls);
    if (step % 50 === 0) samples.push(sample(step * 0.05, s));
  }
  return samples;
}

/** The committed physics fixtures: file name and builder. */
export function physicsCases(): { file: string; build: () => unknown }[] {
  return [
    { file: 'trajectory-space-60s.json', build: () => ({ dt: 0.05, samples: spaceTrajectory() }) },
    {
      file: 'trajectory-descent-30s.json',
      build: () => ({ dt: 0.05, samples: descentTrajectory() }),
    },
  ];
}
