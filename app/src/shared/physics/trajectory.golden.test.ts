import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHYSICS_FIXTURE_DIR } from '@tests/support/fixtures.ts';
import { descentTrajectory, spaceTrajectory, type Sample } from '@tests/support/trajectories.ts';

const load = (file: string): { dt: number; samples: Sample[] } =>
  JSON.parse(readFileSync(path.join(PHYSICS_FIXTURE_DIR, file), 'utf8')) as {
    dt: number;
    samples: Sample[];
  };

/** Compares trajectories numerically: same-engine determinism (1e-9) and the 0.01 m rounding bound. */
function expectClose(actual: Sample[], expected: Sample[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => {
    const e = expected[i]!;
    expect([a.frame, a.regime, a.onPad], `sample ${i} state`).toEqual([e.frame, e.regime, e.onPad]);
    for (const key of ['pos', 'vel', 'quat'] as const) {
      a[key].forEach((value, j) => {
        expect(Math.abs(value - e[key][j]!), `sample ${i} ${key}[${j}]`).toBeLessThanOrEqual(
          tolerance,
        );
      });
    }
  });
}

describe('golden trajectories (deterministic sim)', () => {
  it('re-running the 60 s space flight reproduces the committed fixture', () => {
    const fixture = load('trajectory-space-60s.json');
    expect(fixture.samples).toHaveLength(13);
    expectClose(spaceTrajectory(), fixture.samples, 0.01);
    expectClose(spaceTrajectory(), spaceTrajectory(), 0); // bit-identical within one engine
  });

  it('re-running the 30 s atmospheric descent reproduces the committed fixture and lands on the pad', () => {
    const fixture = load('trajectory-descent-30s.json');
    expectClose(descentTrajectory(), fixture.samples, 0.01);
    const last = fixture.samples[fixture.samples.length - 1]!;
    expect(last.onPad).toBe('golden-pad');
    expect(last.regime).toBe('surface');
    expect(fixture.samples.some((s) => s.regime === 'atmosphere')).toBe(true);
  });

  it('the space fixture shows the expected physics: cruise at ~1.2 Mm/s, then braked to a stop', () => {
    const { samples } = load('trajectory-space-60s.json');
    const speed = (s: Sample) => Math.hypot(...s.vel);
    expect(speed(samples[0]!)).toBe(0);
    expect(speed(samples[1]!)).toBeGreaterThan(1e6); // full throttle reaches cruise within 5 s
    expect(speed(samples[8]!)).toBeGreaterThan(1e6); // ~1.2 Mm/s open-space cruise
    expect(speed(samples[12]!)).toBe(0); // brake stops it dead, no reversal
  });
});
