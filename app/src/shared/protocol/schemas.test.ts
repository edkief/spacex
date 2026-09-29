import { describe, expect, it } from 'vitest';
import { messageSchemas, type EntityState, type StateSnapshot } from '@shared/protocol/schemas';

/**
 * Parametrized table: every message type must accept a valid example and
 * reject a malformed one.
 */

const vec = { x: 1, y: -2, z: 3.5 };

const entity: EntityState = {
  id: 'ship-1',
  kind: 'ship',
  pos: vec,
  vel: { x: 0, y: 0, z: 0 },
  regime: 'sublight',
  hull: 0.8,
  shields: 1,
  targetId: null,
  classId: 'freighter',
  callsign: 'drifter',
  livery: { hull: '#123456' },
};

const snapshot: StateSnapshot = {
  systemId: 'sys-1',
  entities: [entity],
  nodes: [{ id: 'node-1', planetId: 'planet-1', type: 'iron', pos: vec, quantity: 50 }],
  chat: [
    {
      id: 'chat-1',
      authorId: 'player-1',
      callsign: 'drifter',
      channel: 'local',
      text: 'hello world',
      ts: '2026-01-01T00:00:00Z',
    },
  ],
  players: [{ playerId: 'player-1', callsign: 'drifter' }],
};

const player = snapshot.players[0];

const CASES: Record<string, { valid: unknown; invalid: unknown }> = {
  hello: { valid: { v: 1 }, invalid: { v: 'one' } },
  auth: { valid: { callsign: 'drifter' }, invalid: {} },
  join_system: { valid: { systemId: 'sys-1' }, invalid: { systemId: '' } },
  enter_system: { valid: { snapshot }, invalid: { snapshot: { ...snapshot, chat: 5 } } },
  state_snapshot: {
    valid: snapshot,
    invalid: { systemId: 'sys-1', entities: 'nope', nodes: [], chat: [], players: [] },
  },
  entity_update: { valid: { entities: [entity] }, invalid: { entities: [] } },
  chat: { valid: { text: 'hello' }, invalid: { text: '' } },
  input: {
    valid: { seq: 1, thrust: 0.5, turn: 0, pitch: 0, yaw: 0, fire: true, lock: false },
    invalid: { seq: 1, thrust: Infinity, turn: 0, pitch: 0, yaw: 0, fire: true, lock: false },
  },
  warp: { valid: { destinationSystemId: 'sys-2' }, invalid: { destinationSystemId: 123 } },
  interact: {
    valid: { targetId: 't-1', action: 'board' },
    invalid: { targetId: 't-1', action: '' },
  },
  mine: { valid: { nodeId: 'node-1' }, invalid: { nodeId: 7 } },
  sell: {
    valid: { cargoId: 'cargo-1', quantity: 2 },
    invalid: { cargoId: 'cargo-1', quantity: 0 },
  },
  buy_ship: { valid: { classId: 'freighter' }, invalid: { classId: '' } },
  set_livery: {
    valid: { livery: { hull: '#123456' } },
    invalid: { livery: { hull: 'red' } },
  },
  exit_ship: { valid: { shipId: 'ship-1' }, invalid: { shipId: '' } },
  enter_ship: { valid: { shipId: 'ship-1' }, invalid: { shipId: null } },
  repair: { valid: {}, invalid: 'not-an-object' },
  error: {
    valid: { code: 'rate-limited', message: 'slow down' },
    invalid: { code: '', message: 'x' },
  },
  ping: { valid: {}, invalid: 'not-an-object' },
  pong: { valid: {}, invalid: [1, 2, 3] },
  presence: {
    valid: { event: 'join', player },
    invalid: { event: 'explode', player },
  },
  target_update: { valid: { targetId: null }, invalid: { targetId: 42 } },
  combat_event: {
    valid: { kind: 'hit', attacker: 'a', target: 'b', weapon: 'laser', damage: 12 },
    invalid: { kind: 'nuke', attacker: 'a', target: 'b', weapon: 'laser', damage: 12 },
  },
};

describe('message payload schemas', () => {
  it('covers every registered message type exactly once', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(messageSchemas).sort());
  });

  for (const [type, { valid, invalid }] of Object.entries(CASES)) {
    it(`${type}: accepts a valid payload`, () => {
      expect(messageSchemas[type as keyof typeof messageSchemas].safeParse(valid).success).toBe(
        true,
      );
    });

    it(`${type}: rejects a malformed payload`, () => {
      expect(messageSchemas[type as keyof typeof messageSchemas].safeParse(invalid).success).toBe(
        false,
      );
    });
  }

  it('auth also accepts a token instead of a callsign', () => {
    expect(messageSchemas.auth.safeParse({ token: 's3cr3t' }).success).toBe(true);
  });

  it('rejects non-finite numbers in EntityState and combat damage', () => {
    const brokenEntity = { ...entity, pos: { ...vec, x: NaN } };
    expect(messageSchemas.entity_update.safeParse({ entities: [brokenEntity] }).success).toBe(
      false,
    );
    expect(
      messageSchemas.combat_event.safeParse({
        kind: 'kill',
        attacker: 'a',
        target: 'b',
        weapon: 'torpedo',
        damage: Infinity,
      }).success,
    ).toBe(false);
  });

  it('caps chat history at 100 messages in a snapshot', () => {
    const msgs = Array.from({ length: 101 }, (_, i) => ({ ...snapshot.chat[0], id: `m${i}` }));
    expect(messageSchemas.state_snapshot.safeParse({ ...snapshot, chat: msgs }).success).toBe(
      false,
    );
    expect(
      messageSchemas.state_snapshot.safeParse({ ...snapshot, chat: msgs.slice(0, 100) }).success,
    ).toBe(true);
  });
});
