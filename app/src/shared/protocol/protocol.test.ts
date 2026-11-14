import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGES,
  CLIENT_TYPES,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  SERVER_TYPES,
  decodeEnvelope,
  encodeMessage,
  isClientType,
  parseClientMessage,
  parseMessage,
  parseServerMessage,
  type ClientMessage,
  type ClientType,
  type ServerType,
} from '@shared/protocol.ts';
import {
  INVALID_CLIENT_PAYLOADS,
  VALID_CLIENT_PAYLOADS,
  VALID_SERVER_PAYLOADS,
} from '@shared/protocol/examples.ts';

const SPEC_TYPES = [
  'hello',
  'auth',
  'join_system',
  'enter_system',
  'state_snapshot',
  'entity_update',
  'chat',
  'input',
  'warp',
  'interact',
  'mine',
  'sell',
  'buy_ship',
  'set_livery',
  'exit_ship',
  'enter_ship',
  'repair',
  'error',
  'ping',
  'pong',
  'presence',
  'target_update',
  'combat_event',
];

describe('protocol registries', () => {
  it('cover every message type named in the spec, across the two directions', () => {
    const all = new Set<string>([...CLIENT_TYPES, ...SERVER_TYPES]);
    for (const type of SPEC_TYPES) expect(all.has(type), type).toBe(true);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('keep the two directions separate: server types are unknown to the server', () => {
    for (const type of [
      'welcome',
      'auth_ok',
      'enter_system',
      'state_snapshot',
      'entity_update',
      'presence',
      'combat_event',
      'error',
    ]) {
      expect(isClientType(type), type).toBe(false);
      const result = parseClientMessage(type, VALID_SERVER_PAYLOADS[type as ServerType]);
      expect(result).toMatchObject({ ok: false, error: { code: 'unknown-type' } });
    }
    expect(parseServerMessage('hello', { v: 1 })).toMatchObject({
      ok: false,
      error: { code: 'unknown-type' },
    });
  });

  it('never treats prototype keys as message types', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parseClientMessage(type, {})).toMatchObject({
        ok: false,
        error: { code: 'unknown-type' },
      });
      expect(parseServerMessage(type, {})).toMatchObject({
        ok: false,
        error: { code: 'unknown-type' },
      });
    }
  });

  it('has an example for every registered type', () => {
    expect(Object.keys(VALID_CLIENT_PAYLOADS).sort()).toEqual(Object.keys(CLIENT_MESSAGES).sort());
    expect(Object.keys(VALID_SERVER_PAYLOADS).sort()).toEqual(Object.keys(SERVER_MESSAGES).sort());
    expect(Object.keys(INVALID_CLIENT_PAYLOADS).sort()).toEqual(
      Object.keys(CLIENT_MESSAGES).sort(),
    );
  });
});

describe('client payload schemas', () => {
  it.each(CLIENT_TYPES)('%s accepts its valid example', (type) => {
    const result = parseClientMessage(type, VALID_CLIENT_PAYLOADS[type]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  const invalid = CLIENT_TYPES.flatMap((type) =>
    INVALID_CLIENT_PAYLOADS[type].map((payload, i) => [type, i, payload] as const),
  );
  it.each(invalid)('%s rejects malformed payload #%i', (type, _index, payload) => {
    expect(parseClientMessage(type, payload)).toMatchObject({
      ok: false,
      error: { code: 'invalid-message' },
    });
  });
});

describe('server payload schemas', () => {
  it.each(SERVER_TYPES)('%s accepts its valid example and rejects a malformed one', (type) => {
    expect(parseServerMessage(type, VALID_SERVER_PAYLOADS[type]).ok).toBe(true);
    expect(parseServerMessage(type, { garbage: true })).toMatchObject({ ok: false });
    expect(parseServerMessage(type, null)).toMatchObject({ ok: false });
  });

  it('requires frames in positions, unit quaternions and bounded finite numbers', () => {
    const snapshot = VALID_SERVER_PAYLOADS.state_snapshot as {
      entities: Record<string, unknown>[];
    };
    const entity = snapshot.entities[0]!;
    const bad = (patch: Record<string, unknown>) =>
      parseServerMessage('entity_update', {
        tick: 1,
        lastInputSeq: 0,
        entities: [{ ...entity, ...patch }],
      }).ok;
    expect(bad({})).toBe(true);
    expect(bad({ pos: { x: 1, y: 2, z: 3 } })).toBe(false);
    expect(bad({ pos: { frame: 'planet', x: 1, y: 2, z: 3 } })).toBe(false);
    expect(bad({ pos: { frame: 'fedcba9876543210', x: 1, y: 2, z: 3 } })).toBe(true);
    expect(bad({ quat: { x: 1, y: 1, z: 1, w: 1 } })).toBe(false);
    expect(bad({ vel: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } })).toBe(false);
    expect(bad({ hull: -1 })).toBe(false);
    expect(bad({ classId: null, kind: 'character' })).toBe(true);
  });

  it('carries tick and the per-recipient last input seq on snapshots and updates', () => {
    for (const type of ['enter_system', 'state_snapshot', 'entity_update'] as const) {
      const payload = VALID_SERVER_PAYLOADS[type] as Record<string, unknown>;
      expect(payload).toHaveProperty('tick');
      expect(payload).toHaveProperty('lastInputSeq');
    }
  });
});

describe('envelope', () => {
  it('round-trips an encoded message', () => {
    const text = encodeMessage('ping', { t: 5 });
    expect(JSON.parse(text)).toEqual({ v: 1, type: 'ping', payload: { t: 5 } });
    expect(decodeEnvelope(text)).toEqual({
      ok: true,
      value: { v: 1, type: 'ping', payload: { t: 5 } },
    });
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['missing type', '{"v":1,"payload":{}}'],
    ['non-integer version', '{"v":1.5,"type":"ping","payload":{}}'],
    ['empty type', '{"v":1,"type":"","payload":{}}'],
    ['extra field', '{"v":1,"type":"ping","payload":{},"x":1}'],
  ])('rejects %s', (_label, text) => {
    expect(decodeEnvelope(text)).toMatchObject({ ok: false, error: { code: 'invalid-message' } });
  });

  it('parseMessage dispatches on direction', () => {
    expect(parseMessage('c2s', 'hello', { v: 1 }).ok).toBe(true);
    expect(parseMessage('s2c', 'hello', { v: 1 }).ok).toBe(false);
    expect(parseMessage('s2c', 'welcome', VALID_SERVER_PAYLOADS.welcome).ok).toBe(true);
  });
});

describe('exhaustive typing', () => {
  /** Compiles only while every client message type is handled (a `never` check). */
  function describeMessage(message: ClientMessage): string {
    switch (message.type) {
      case 'hello':
        return `hello v${message.payload.v}`;
      case 'auth':
        return 'auth';
      case 'logout':
        return 'logout';
      case 'join_system':
        return message.payload.systemId;
      case 'chat':
        return message.payload.text;
      case 'input':
        return String(message.payload.seq);
      case 'warp':
        return message.payload.targetSystemId;
      case 'interact':
        return message.payload.targetId;
      case 'mine':
        return message.payload.nodeId;
      case 'sell':
        return String(message.payload.quantity);
      case 'buy_ship':
        return message.payload.classId;
      case 'set_livery':
        return message.payload.livery.hull;
      case 'exit_ship':
        return 'exit';
      case 'enter_ship':
        return message.payload.shipId;
      case 'repair':
        return message.payload.shipId;
      case 'target_update':
        return String(message.payload.targetId);
      case 'ping':
        return 'ping';
      case 'pong':
        return 'pong';
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  it('lets handlers switch over inferred discriminated unions', () => {
    const parsed = parseClientMessage('sell', VALID_CLIENT_PAYLOADS.sell);
    if (!parsed.ok) throw new Error('expected ok');
    expect(describeMessage(parsed.value)).toBe('5');
    const types: ClientType[] = CLIENT_TYPES;
    expect(types.length).toBe(18);
  });
});
