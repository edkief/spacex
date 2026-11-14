import { describe, expect, it } from 'vitest';
import { frameSwitchAltitude, regimeBandTop } from '@shared/physics/bodies.ts';
import { selectFrame } from '@shared/physics/frameSelect.ts';
import { SYSTEM_FRAME } from '@shared/physics/frames.ts';
import { CENTER, NORTH, R, SOUTH, at, body, planet } from '@shared/physics/testkit.ts';
import { Rng } from '@shared/random.ts';
import { add } from '@shared/physics/vec.ts';
import { CHART_SWITCH_SIN_LATITUDE } from '@shared/physics/worldConstants.ts';

describe('frame selection', () => {
  const gas = planet({
    id: 'aaaaaaaaaaaaaaaa',
    hasSurfaceFrame: false,
    center: { x: 0, y: 0, z: 50_000_000 },
    radius: 400_000,
    atmosphere: { density: 3, top: 48_000 },
  });
  const bodies = [gas, body];
  const switchAlt = frameSwitchAltitude(body);

  it('computes max(atmosphere top + 1 km, 3 km) as the switch altitude', () => {
    expect(switchAlt).toBeCloseTo(0.12 * R + 1000, 6);
    expect(
      frameSwitchAltitude(planet({ radius: 20_000, atmosphere: { density: 1, top: 2400 } })),
    ).toBeCloseTo(3400, 6);
    expect(frameSwitchAltitude(planet({ atmosphere: null }))).toBe(3000);
    expect(regimeBandTop(planet({ atmosphere: null }))).toBe(3000);
    expect(regimeBandTop(body)).toBeCloseTo(0.12 * R, 6);
  });

  it('enters the surface frame below the switch altitude and not above it', () => {
    expect(selectFrame(SYSTEM_FRAME, at(1, 0, switchAlt + 1), 0, bodies)).toBe(SYSTEM_FRAME);
    expect(selectFrame(SYSTEM_FRAME, at(1, 0, switchAlt - 1), 0, bodies)).toBe(NORTH);
  });

  it('leaves only above 1.1x the switch altitude (hysteresis; no flapping under +/-1 m noise)', () => {
    expect(selectFrame(NORTH, at(1, 0, 0), switchAlt * 1.1 - 1, bodies)).toBe(NORTH);
    expect(selectFrame(NORTH, at(1, 0, 0), switchAlt * 1.1 + 1, bodies)).toBe(SYSTEM_FRAME);
    const rng = new Rng(13n);
    let frame: ReturnType<typeof selectFrame> = NORTH;
    let flips = 0;
    for (let i = 0; i < 500; i++) {
      const alt = switchAlt * 1.05 + rng.nextRange(-1, 1); // hovering inside the hysteresis band
      const next = selectFrame(frame, at(1, 0, alt), alt, bodies);
      if (next !== frame) flips++;
      frame = next;
    }
    expect(flips).toBe(0);
  });

  it('never gives gas giants, the star or unlandable planets a surface frame', () => {
    const solid = { ...gas, center: { x: 0, y: 0, z: 0 } };
    expect(selectFrame(SYSTEM_FRAME, { x: 0, y: 0, z: solid.radius + 100 }, 0, [solid])).toBe(
      SYSTEM_FRAME,
    );
    expect(selectFrame(SYSTEM_FRAME, at(1, 0, 10), 0, [planet({ hasSurfaceFrame: false })])).toBe(
      SYSTEM_FRAME,
    );
  });

  it('enters the chart of the hemisphere the ship is over', () => {
    expect(selectFrame(SYSTEM_FRAME, at(1.2, 0, 100), 0, bodies)).toBe(NORTH);
    expect(selectFrame(SYSTEM_FRAME, at(2.0, 0, 100), 0, bodies)).toBe(SOUTH);
    expect(selectFrame(SYSTEM_FRAME, at(Math.PI, 0, 100), 0, bodies)).toBe(SOUTH);
  });

  it('changes chart only a little past the equator, in both directions, without flapping', () => {
    const past = Math.asin(CHART_SWITCH_SIN_LATITUDE);
    const equator = Math.PI / 2;
    expect(selectFrame(NORTH, at(equator + past - 0.001, 1, 50), 50, bodies)).toBe(NORTH);
    expect(selectFrame(NORTH, at(equator + past + 0.001, 1, 50), 50, bodies)).toBe(SOUTH);
    expect(selectFrame(SOUTH, at(equator - past + 0.001, 1, 50), 50, bodies)).toBe(SOUTH);
    expect(selectFrame(SOUTH, at(equator - past - 0.001, 1, 50), 50, bodies)).toBe(NORTH);
    const rng = new Rng(7n);
    let frame: ReturnType<typeof selectFrame> = NORTH;
    let flips = 0;
    for (let i = 0; i < 500; i++) {
      // Loitering on the equator with +/- 100 m of north-south noise.
      const next = selectFrame(
        frame,
        at(equator + rng.nextRange(-1, 1) * (100 / R), 1, 50),
        50,
        bodies,
      );
      if (next !== frame) flips++;
      frame = next;
    }
    expect(flips).toBe(0);
  });

  it('picks the lowest-altitude planet when two frames could apply and falls back for unknown frames', () => {
    const near = planet({
      id: 'bbbbbbbbbbbbbbbb',
      center: add(CENTER, { x: 0, y: 0, z: 2 * R + 3000 }),
    });
    const p = add(CENTER, { x: 0, y: 0, z: R + 500 });
    expect(selectFrame(SYSTEM_FRAME, p, 0, [body, near])).toBe(NORTH);
    expect(selectFrame('deadbeefdeadbeef:n', p, 0, [body])).toBe(SYSTEM_FRAME);
  });
});
