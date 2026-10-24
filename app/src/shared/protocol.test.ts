import { describe, it, expect } from 'vitest';
import { MessageSchemas } from './protocol/schemas';

describe('Protocol Schemas', () => {
  const testCases = [
    {
      type: 'hello',
      valid: { v: 1 },
      invalid: { v: '1' },
    },
    {
      type: 'auth',
      valid: { callsign: 'Ace' },
      invalid: { callsign: 123 },
    },
    {
      type: 'join_system',
      valid: { systemId: 'sys-1' },
      invalid: { systemId: null },
    },
    {
      type: 'ping',
      valid: { ts: Date.now() },
      invalid: { ts: 'now' },
    },
    {
      type: 'error',
      valid: { code: 'version-mismatch', message: 'Wrong version' },
      invalid: { code: 'unknown-code', message: 'Wrong version' },
    },
    {
      type: 'input',
      valid: { seq: 1, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      invalid: { seq: '1', thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
    },
  ];

  testCases.forEach(({ type, valid, invalid }) => {
    it(`should validate ${type} messages`, () => {
      const schema = MessageSchemas[type];
      expect(schema?.safeParse(valid).success).toBe(true);
      expect(schema?.safeParse(invalid).success).toBe(false);
    });
  });
});
