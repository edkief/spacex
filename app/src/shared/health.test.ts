import { describe, expect, it } from 'vitest';
import { buildHealth } from '@shared/health';

describe('buildHealth', () => {
  it('reports ok with the galaxy seed', () => {
    expect(buildHealth('abc')).toEqual({ ok: true, galaxySeed: 'abc' });
  });
});
