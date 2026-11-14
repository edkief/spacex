import { describe, expect, it } from 'vitest';
import { frameSwitchAltitude, regimeBandTop } from '@shared/physics/bodies.ts';
import { selectFrame } from '@shared/physics/frameSelect.ts';
import { SYSTEM_FRAME } from '@shared/physics/frames.ts';
import { CENTER, R, at, body, planet } from '@shared/physics/testkit.ts';
import { Rng } from '@shared/random.ts';
import { add } from '@shared/physics/vec.ts';
import { MAX_COLATITUDE } from '@shared/physics/worldConstants.ts';

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
    expect(selectFrame(SYSTEM_FRAME, at(1, 0, switchAlt - 1), 0, bodies)).toBe(body.id);
  });

  it('leaves only above 1.1x the switch altitude (hysteresis; no flapping under +/-1 m noise)', () => {
    expect(selectFrame(body.id, at(1, 0, 0), switchAlt * 1.1 - 1, bodies)).toBe(body.id);
    expect(selectFrame(body.id, at(1, 0, 0), switchAlt * 1.1 + 1, bodies)).toBe(SYSTEM_FRAME);
    const rng = new Rng(13n);
    let frame = body.id;
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

  it('refuses the surface frame in the south polar cap (theta > 0.97 pi)', () => {
    expect(selectFrame(SYSTEM_FRAME, at(MAX_COLATITUDE + 0.01, 0, 100), 0, bodies)).toBe(
      SYSTEM_FRAME,
    );
    expect(selectFrame(SYSTEM_FRAME, at(MAX_COLATITUDE - 0.01, 0, 100), 0, bodies)).toBe(body.id);
  });

  it('picks the lowest-altitude planet when two frames could apply and falls back for unknown frames', () => {
    const near = planet({
      id: 'bbbbbbbbbbbbbbbb',
      center: add(CENTER, { x: 0, y: 0, z: 2 * R + 3000 }),
    });
    const p = add(CENTER, { x: 0, y: 0, z: R + 500 });
    expect(selectFrame(SYSTEM_FRAME, p, 0, [body, near])).toBe(body.id);
    expect(selectFrame('deadbeefdeadbeef', p, 0, [body])).toBe(SYSTEM_FRAME);
  });
});
