import { describe, expect, it } from 'vitest';
import {
  DROP_AFTER_MS,
  PING_INTERVAL_MS,
  PROTOCOL_ERRORS,
  PROTOCOL_VERSION,
  UNKNOWN_TYPE_DROP_LIMIT,
  decodeMessage,
  encodeMessage,
  parseMessage,
} from '@shared/protocol';
import type { InputPayload } from '@shared/protocol/schemas';

const validInput: InputPayload = {
  seq: 1,
  thrust: 0.5,
  turn: 0.1,
  pitch: -0.2,
  yaw: 0,
  fire: true,
  lock: false,
  action: 'boost',
};

describe('protocol constants', () => {
  it('has a current version, 15 s ping, 45 s drop, 10 unknown-type limit', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PING_INTERVAL_MS).toBe(15_000);
    expect(DROP_AFTER_MS).toBe(45_000);
    expect(UNKNOWN_TYPE_DROP_LIMIT).toBe(10);
  });

  it('defines exactly the seven structured error codes', () => {
    expect(Object.values(PROTOCOL_ERRORS).sort()).toEqual(
      [
        'invalid-message',
        'rate-limited',
        'system-full',
        'system-not-found',
        'unauthenticated',
        'unknown-type',
        'version-mismatch',
      ].sort(),
    );
  });
});

describe('encode/decode round trip', () => {
  it('round-trips a typed message', () => {
    const wire = encodeMessage('input', validInput);
    expect(JSON.parse(wire).v).toBe(PROTOCOL_VERSION);
    const decoded = decodeMessage(wire);
    expect(decoded).toEqual({
      ok: true,
      envelope: { v: PROTOCOL_VERSION, type: 'input', payload: validInput },
    });
  });

  it('supports non-default protocol versions on encode', () => {
    expect(JSON.parse(encodeMessage('ping', {}, 3)).v).toBe(3);
  });

  it('decodes Buffer payloads', () => {
    const decoded = decodeMessage(Buffer.from(encodeMessage('pong', {})));
    expect(decoded.ok).toBe(true);
  });

  it('rejects non-JSON, non-objects, and broken envelopes', () => {
    expect(decodeMessage('not json').ok).toBe(false);
    expect(decodeMessage('"a string"').ok).toBe(false);
    expect(decodeMessage('null').ok).toBe(false);
    expect(decodeMessage('{"type":"ping"}').ok).toBe(false); // missing v
    expect(decodeMessage('{"v":1.5,"type":"ping"}').ok).toBe(false); // non-integer v
    expect(decodeMessage('{"v":1,"payload":{}}').ok).toBe(false); // missing type
  });
});

describe('parseMessage', () => {
  it('accepts a known type with a valid payload', () => {
    const parsed = parseMessage('input', validInput);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe('input');
      expect(parsed.payload).toEqual(validInput);
    }
  });

  it('applies schema defaults', () => {
    const parsed = parseMessage('chat', { text: 'hi' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.payload).toEqual({ channel: 'local', text: 'hi' });
  });

  it('rejects a malformed payload with invalid-message and the failing path', () => {
    const parsed = parseMessage('input', { ...validInput, thrust: NaN });
    expect(parsed).toMatchObject({ ok: false, code: 'invalid-message' });
    if (!parsed.ok) expect(parsed.message).toContain('thrust');
  });

  it('rejects unknown types with unknown-type', () => {
    const parsed = parseMessage('teleport', {});
    expect(parsed).toEqual({
      ok: false,
      code: 'unknown-type',
      message: 'unknown message type: teleport',
    });
  });
});
