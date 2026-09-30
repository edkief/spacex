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
  logout: { valid: {}, invalid: { token: 'extra-field' } },
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
  ack: { valid: { seq: 42 }, invalid: { seq: 4.5 } },
  ping: { valid: {}, invalid: 'not-an-object' },
  pong: { valid: {}, invalid: [1, 2, 3] },
  presence: {
    valid: { event: 'join', player },
    invalid: { event: 'explode', player },
  },
  target_update: { valid: { targetId: null }, invalid: { targetId: 42 } },
  combat_event: {
    valid: {
      kind: 'damaged',
      target: 'b',
      source: { kind: 'player', id: 'a' },
      amount: 12,
      shieldHit: 8,
      hullHit: 4,
    },
    invalid: {
      kind: 'nuke',
      target: 'b',
      source: { kind: 'player', id: 'a' },
      amount: 12,
      shieldHit: 8,
      hullHit: 4,
    },
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
        kind: 'damaged',
        target: 'b',
        source: { kind: 'player', id: 'a' },
        amount: Infinity,
        shieldHit: 0,
        hullHit: 0,
      }).success,
    ).toBe(false);
  });

  it('combat_event accepts the killed variant and rejects unknown kinds and shapes', () => {
    // The killing hit: {kind:'destroyed', target, source} — no damage fields.
    expect(
      messageSchemas.combat_event.safeParse({
        kind: 'destroyed',
        target: 'b',
        source: { kind: 'ai', id: 'rogue-1' },
      }).success,
    ).toBe(true);
    // Old placeholder kinds are gone (TASK-23 rewired the contract).
    expect(
      messageSchemas.combat_event.safeParse({ kind: 'hit', attacker: 'a', target: 'b' }).success,
    ).toBe(false);
    expect(
      messageSchemas.combat_event.safeParse({
        kind: 'kill',
        attacker: 'a',
        target: 'b',
        weapon: 'torpedo',
        damage: 1,
      }).success,
    ).toBe(false);
    // Strict: the destroyed variant takes no damage fields.
    expect(
      messageSchemas.combat_event.safeParse({
        kind: 'destroyed',
        target: 'b',
        source: { kind: 'player', id: 'a' },
        amount: 5,
      }).success,
    ).toBe(false);
    // Source must be a player/ai discriminant.
    expect(
      messageSchemas.combat_event.safeParse({
        kind: 'damaged',
        target: 'b',
        source: { kind: 'alien', id: 'a' },
        amount: 1,
        shieldHit: 0,
        hullHit: 1,
      }).success,
    ).toBe(false);
  });

  it('EntityState carries an optional orientation (TASK-14 reconciliation/slerp)', () => {
    // No rot: back-compat with v1 producers — must parse.
    expect(messageSchemas.entity_update.safeParse({ entities: [entity] }).success).toBe(true);
    // Valid unit quat parses and round-trips.
    const withRot = { ...entity, rot: { x: 0, y: 0, z: 0.70710678, w: 0.70710678 } };
    const parsed = messageSchemas.entity_update.safeParse({ entities: [withRot] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { entities: { rot?: unknown }[] }).entities[0].rot).toEqual(
        withRot.rot,
      );
    }
    // Non-numeric / partial rot rejected.
    expect(
      messageSchemas.entity_update.safeParse({
        entities: [{ ...entity, rot: { x: 0, y: 0, z: 1 } }],
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
