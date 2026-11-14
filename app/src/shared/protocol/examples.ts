import type { ClientType, ServerType } from './registry.ts';

const SYSTEM = '0123456789abcdef';
const PLANET = 'fedcba9876543210';
const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_B = '9b2f4c1a-7d3e-4a5b-8c6d-1e2f3a4b5c6d';

const pos = { frame: 'system', x: 1.5, y: -2, z: 3 };
const vec = { x: 0, y: 1, z: -1 };
const quat = { x: 0, y: 0, z: 0, w: 1 };
/** A valid, all-neutral flight input. */
export const GOOD_INPUT = {
  seq: 1,
  thrust: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  up: 0,
  brake: false,
  fire: false,
  lock: false,
  action: 'none',
};

const livery = { hull: '#112233', accent: '#445566', trim: '#778899' };

const entity = {
  id: UUID_A,
  kind: 'ship',
  pos,
  vel: vec,
  quat,
  regime: 'space',
  hull: 80,
  shields: 40,
  targetId: null,
  classId: 'scout',
  callsign: 'TEST-ALPHA',
  livery,
};

const snapshot = {
  systemId: SYSTEM,
  tick: 12,
  lastInputSeq: 3,
  entities: [entity],
  nodes: [
    { nodeId: PLANET, type: 'iron', pos: { ...pos, frame: `${PLANET}:n` as const }, quantity: 40 },
  ],
  chat: [{ from: 'TEST-BRAVO', text: 'hi', at: 1700000000000 }],
  players: [{ playerId: UUID_A, callsign: 'TEST-ALPHA', entityId: UUID_A }],
};

/** One valid payload per message type, shared by protocol, fuzz and integration tests. */
export const VALID_CLIENT_PAYLOADS: Record<ClientType, unknown> = {
  hello: { v: 1 },
  auth: { token: 'abc.def' },
  logout: {},
  join_system: { systemId: SYSTEM },
  chat: { text: 'hello there' },
  input: { ...GOOD_INPUT, thrust: 1, yaw: -0.5 },
  warp: { targetSystemId: SYSTEM },
  interact: { targetId: UUID_A },
  mine: { nodeId: PLANET, active: true },
  sell: { resourceType: 'iron', quantity: 5 },
  buy_ship: { classId: 'freighter' },
  set_livery: { shipId: UUID_A, livery },
  exit_ship: {},
  enter_ship: { shipId: UUID_B },
  repair: { shipId: UUID_A },
  target_update: { targetId: PLANET },
  ping: { t: 1700000000000 },
  pong: { t: 1700000000000 },
};

export const VALID_SERVER_PAYLOADS: Record<ServerType, unknown> = {
  welcome: { v: 1, tickRate: 20, snapshotRate: 10, serverTime: 1700000000000 },
  auth_ok: { playerId: UUID_A, callsign: 'TEST-ALPHA', shipId: UUID_B, homeSystemId: SYSTEM },
  enter_system: { systemId: SYSTEM, tick: 0, lastInputSeq: 0, snapshot },
  state_snapshot: snapshot,
  entity_update: { tick: 13, lastInputSeq: 4, entities: [entity] },
  chat: { from: 'TEST-ALPHA', text: 'hello', at: 1700000000000 },
  presence: {
    joined: [{ playerId: UUID_A, callsign: 'TEST-ALPHA', entityId: null }],
    left: [UUID_B],
  },
  target_update: { entityId: UUID_A, targetId: null },
  combat_event: {
    tick: 5,
    kind: 'hit',
    attacker: UUID_A,
    target: UUID_B,
    weapon: 'laser',
    damage: 12.5,
  },
  error: { code: 'rate-limited', message: 'slow down' },
  ping: { t: 1700000000000 },
  pong: { t: 1700000000000 },
};

/** At least one malformed payload per message type. */
export const INVALID_CLIENT_PAYLOADS: Record<ClientType, unknown[]> = {
  hello: [{}, { v: '1' }, { v: 1.5 }, { v: 1, extra: true }, null],
  auth: [
    {},
    { token: '' },
    { token: 5 },
    { token: 'x'.repeat(513) },
    { token: 'a', callsign: 'b' },
  ],
  logout: [{ extra: 1 }, null, []],
  join_system: [
    {},
    { systemId: 'NOT-HEX' },
    { systemId: 'ABCDEF0123456789' },
    { systemId: SYSTEM, x: 1 },
  ],
  chat: [
    {},
    { text: '' },
    { text: '   ' },
    { text: 'x'.repeat(281) },
    { text: 'bad\u0007bell' },
    { text: 5 },
  ],
  input: [
    {},
    { ...GOOD_INPUT, seq: -1 },
    { ...GOOD_INPUT, seq: 1.5 },
    { ...GOOD_INPUT, thrust: 2 },
    { ...GOOD_INPUT, thrust: Number.NaN },
    { ...GOOD_INPUT, up: -1.5 },
    { ...GOOD_INPUT, roll: '1' },
    { ...GOOD_INPUT, brake: 'yes' },
    { ...GOOD_INPUT, fire: 'yes' },
    { ...GOOD_INPUT, action: 'explode' },
    { ...GOOD_INPUT, turn: 0 },
    { seq: 1, thrust: 0, yaw: 0, pitch: 0 },
  ],
  warp: [{}, { targetSystemId: 'x' }, { targetSystemId: SYSTEM, extra: 1 }],
  interact: [{}, { targetId: 'nope' }, { targetId: 5 }],
  mine: [{ nodeId: PLANET }, { nodeId: 'zz', active: true }, { nodeId: PLANET, active: 'yes' }],
  sell: [
    {},
    { resourceType: 'iron', quantity: 0 },
    { resourceType: 'iron', quantity: 1.5 },
    { resourceType: '', quantity: 1 },
  ],
  buy_ship: [{}, { classId: 'battleship' }, { classId: 5 }],
  set_livery: [
    {},
    { shipId: UUID_A },
    { shipId: UUID_A, livery: { hull: 'red', accent: '#000000', trim: '#000000' } },
  ],
  exit_ship: [{ extra: 1 }, 'x'],
  enter_ship: [{}, { shipId: 'nope' }, { shipId: UUID_A, extra: 1 }],
  repair: [{}, { shipId: 7 }],
  target_update: [{}, { targetId: 5 }, { targetId: undefined }],
  ping: [{}, { t: -1 }, { t: 'now' }, { t: Number.POSITIVE_INFINITY }],
  pong: [{}, { t: null }],
};
