import { describe, expect, it } from 'vitest';
import type { HealthPayload } from '@shared/health';

describe('shared health payload', () => {
  it('shapes the health payload', () => {
    const payload: HealthPayload = { ok: true, galaxySeed: 'DRIFT-SEED-0001' };
    expect(payload.ok).toBe(true);
    expect(payload.galaxySeed).toBe('DRIFT-SEED-0001');
  });
});
