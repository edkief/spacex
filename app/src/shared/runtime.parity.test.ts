import { describe, expect, it } from 'vitest';
import { buildHealth } from '@shared/health';

// Runs under both the node and dom (jsdom) vitest projects; shared code must behave identically.
describe('shared code parity across environments', () => {
  it('serialises the health payload identically', () => {
    expect(JSON.stringify(buildHealth('seed-1'))).toBe('{"ok":true,"galaxySeed":"seed-1"}');
  });
});
