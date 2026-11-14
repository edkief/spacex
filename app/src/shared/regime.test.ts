import { describe, expect, it } from 'vitest';
import { regimeSchema } from '@shared/protocol/world.ts';
import {
  REGIMES,
  REGIME_HYSTERESIS_M,
  SURFACE_ENTER_HEIGHT_M,
  SURFACE_ENTER_SPEED,
  SURFACE_EXIT_HEIGHT_M,
  resolveRegime,
  type Regime,
  type RegimeInput,
} from '@shared/regime.ts';
import { body, planet } from '@shared/physics/testkit.ts';
import { Rng } from '@shared/random.ts';

const TOP = body.atmosphere!.top; // 9,600 m
const input = (over: Partial<RegimeInput>): RegimeInput => ({
  previous: 'space',
  frame: body.id,
  planet: body,
  altitude: TOP + 5000,
  terrainHeight: 100,
  speed: 50,
  ...over,
});

describe('regime resolution', () => {
  it('is defined once: the protocol regime enum is built from REGIMES', () => {
    expect([...regimeSchema.options]).toEqual([...REGIMES]);
  });

  it('enters the atmosphere exactly below the atmosphere top (not at it)', () => {
    expect(resolveRegime(input({ altitude: TOP + 0.001 }))).toBe('space');
    expect(resolveRegime(input({ altitude: TOP }))).toBe('space');
    expect(resolveRegime(input({ altitude: TOP - 0.001 }))).toBe('atmosphere');
  });

  it('leaves the atmosphere only above top + 50 m (hysteresis band)', () => {
    const inAtmo = (altitude: number) => resolveRegime(input({ previous: 'atmosphere', altitude }));
    expect(inAtmo(TOP + 1)).toBe('atmosphere');
    expect(inAtmo(TOP + REGIME_HYSTERESIS_M)).toBe('atmosphere');
    expect(inAtmo(TOP + REGIME_HYSTERESIS_M + 0.001)).toBe('space');
  });

  it('does not flap while crossing slowly or hovering inside the 50 m band', () => {
    let regime: Regime = 'space';
    const changes: Regime[] = [];
    // Slow descent through the boundary, then a long hover at the top of the band, then climb out.
    const profile = [
      ...Array.from({ length: 200 }, (_, i) => TOP + 20 - i * 0.2), // 20 m above -> 20 m below
      ...Array.from({ length: 300 }, () => TOP + 25), // hover inside the band
      ...Array.from({ length: 200 }, (_, i) => TOP - 20 + i * 0.4), // climb out through the band
    ];
    for (const altitude of profile) {
      const next = resolveRegime(input({ previous: regime, altitude }));
      if (next !== regime) changes.push(next);
      regime = next;
    }
    expect(changes).toEqual(['atmosphere', 'space']);
  });

  it('keeps a hovering ship stable under +/-1 m position noise at the boundary', () => {
    const rng = new Rng(5n);
    let regime: Regime = 'atmosphere';
    let flips = 0;
    for (let i = 0; i < 2000; i++) {
      const next = resolveRegime(
        input({ previous: regime, altitude: TOP + 25 + rng.nextRange(-1, 1) }),
      );
      if (next !== regime) flips++;
      regime = next;
    }
    expect(flips).toBe(0);
  });

  it('lands (atmosphere -> surface) only when low AND slow, and lifts off above 5 m or when fast', () => {
    const near = { previous: 'atmosphere' as const, altitude: 100 + SURFACE_ENTER_HEIGHT_M - 0.5 };
    expect(resolveRegime(input({ ...near, speed: SURFACE_ENTER_SPEED - 0.1 }))).toBe('surface');
    expect(resolveRegime(input({ ...near, speed: SURFACE_ENTER_SPEED + 0.1 }))).toBe('atmosphere');
    expect(
      resolveRegime(input({ ...near, altitude: 100 + SURFACE_ENTER_HEIGHT_M + 0.5, speed: 0 })),
    ).toBe('atmosphere');

    const onGround = { previous: 'surface' as const, speed: 0 };
    expect(resolveRegime(input({ ...onGround, altitude: 100 + SURFACE_EXIT_HEIGHT_M }))).toBe(
      'surface',
    );
    expect(resolveRegime(input({ ...onGround, altitude: 100 + SURFACE_EXIT_HEIGHT_M + 0.1 }))).toBe(
      'atmosphere',
    );
    expect(resolveRegime(input({ ...onGround, altitude: 100, speed: 20 }))).toBe('atmosphere');
  });

  it('never goes space <-> surface directly, however far the entity jumps', () => {
    expect(resolveRegime(input({ previous: 'space', altitude: 100, speed: 0 }))).toBe('atmosphere');
    expect(resolveRegime(input({ previous: 'surface', altitude: TOP + 10_000 }))).toBe(
      'atmosphere',
    );
    // ...but two successive resolutions complete the journey.
    const first = resolveRegime(input({ previous: 'surface', altitude: TOP + 10_000 }));
    expect(resolveRegime(input({ previous: first, altitude: TOP + 10_000 }))).toBe('space');
  });

  it('the system frame is always space', () => {
    for (const previous of REGIMES) {
      const regime = resolveRegime(
        input({ previous, frame: 'system', planet: undefined, altitude: 0 }),
      );
      expect(regime).toBe(previous === 'surface' ? 'atmosphere' : 'space');
    }
    expect(resolveRegime(input({ frame: 'system', planet: undefined }))).toBe('space');
  });

  it('uses the low-altitude band (3 km) for airless planets, with the same state machine', () => {
    const airless = planet({ atmosphere: null });
    const at = (previous: Regime, altitude: number) =>
      resolveRegime(input({ planet: airless, previous, altitude }));
    expect(at('space', 3001)).toBe('space');
    expect(at('space', 2999)).toBe('atmosphere');
    expect(at('atmosphere', 3049)).toBe('atmosphere');
    expect(at('atmosphere', 3051)).toBe('space');
  });

  it('is pure: identical inputs give identical results (client and server agree)', () => {
    const rng = new Rng(6n);
    for (let i = 0; i < 2000; i++) {
      const sample = input({
        previous: REGIMES[rng.nextInt(3)]!,
        altitude: rng.nextRange(-10, 20_000),
        terrainHeight: rng.nextRange(0, 400),
        speed: rng.nextRange(0, 400),
      });
      expect(resolveRegime({ ...sample })).toBe(resolveRegime(sample));
    }
  });

  it('every call changes the regime by at most one step in the allowed graph', () => {
    const allowed = new Set([
      'space>atmosphere',
      'atmosphere>space',
      'atmosphere>surface',
      'surface>atmosphere',
    ]);
    const rng = new Rng(7n);
    for (let i = 0; i < 5000; i++) {
      const previous = REGIMES[rng.nextInt(3)]!;
      const next = resolveRegime(
        input({
          previous,
          altitude: rng.nextRange(-50, 30_000),
          terrainHeight: rng.nextRange(0, 400),
          speed: rng.nextRange(0, 100),
        }),
      );
      if (next !== previous)
        expect(allowed.has(`${previous}>${next}`), `${previous}>${next}`).toBe(true);
    }
  });

  it('a scripted flight through every transition, with +/-1 m noise, gives the exact regime sequence', () => {
    const rng = new Rng(8n);
    const ground = 100;
    // Altitude profile (m above datum) and speed: descend, land, wait, lift off, climb away.
    const phases: { alt: number; speed: number }[] = [];
    for (let a = TOP + 3000; a > ground + 1; a -= 40) phases.push({ alt: a, speed: 60 });
    for (let i = 0; i < 100; i++) phases.push({ alt: ground + 0.5, speed: 0 });
    for (let a = ground + 1; a < TOP + 3000; a += 40) phases.push({ alt: a, speed: 25 });
    let regime: Regime = 'space';
    const sequence: Regime[] = ['space'];
    for (const phase of phases) {
      regime = resolveRegime(
        input({
          previous: regime,
          altitude: phase.alt + rng.nextRange(-1, 1),
          terrainHeight: ground,
          speed: phase.speed,
        }),
      );
      if (regime !== sequence[sequence.length - 1]) sequence.push(regime);
    }
    expect(sequence).toEqual(['space', 'atmosphere', 'surface', 'atmosphere', 'space']);
  });
});
