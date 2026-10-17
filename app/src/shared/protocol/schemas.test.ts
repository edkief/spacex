/**
 * Schema validation tests (TASK-9 acceptance criteria).
 *
 * For each registered message type we assert:
 *   1. A canonical "valid example" object passes `schema.parse(payload)`.
 *   2. A canonical "malformed example" object fails with the expected
 *      `ProtocolErrorCode` (or at minimum fails the parse).
 *
 * Both checks live in a single `it.each` table so adding a new message
 * type is a single edit.
 */
import { describe, it, expect } from "vitest";
import { type z } from "zod";

import { PAYLOAD_SCHEMAS, type MessageType, type PayloadFor } from "./schemas.js";
import {
  parseMessage,
  ProtocolError,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
} from "./index.js";

// ---------------------------------------------------------------------------
// Valid example payloads — one per registered message type. Kept here (not
// in `__fixtures__/`) so any schema change is caught by a compiler error
// against this file rather than silently drifting the fixture.
// ---------------------------------------------------------------------------

const VALID_PAYLOADS: Record<MessageType, () => unknown> = {
  hello: () => ({ version: PROTOCOL_VERSION, client: "test-client" }),
  auth: () => ({ callsign: "TEST-ALPHA" }),
  auth_ok: () => ({
    playerId: "p-1234",
    callsign: "TEST-ALPHA",
    tokenExpiresAt: 1_700_000_000_000,
  }),
  join_system: () => ({ systemId: "system-001" }),
  enter_system: () => ({
    systemId: "system-001",
    entities: [],
    nodes: [],
    chat: [],
    players: [],
    serverTickHz: 20,
    snapshotTick: 0,
  }),
  state_snapshot: () => ({
    systemId: "system-001",
    tick: 0,
    entities: [],
    nodes: [],
    chat: [],
    players: [],
  }),
  entity_update: () => ({
    systemId: "system-001",
    tick: 1,
    entities: [
      {
        id: "ship-1",
        kind: "ship",
        pos: [0, 0, 0],
        vel: [0, 0, 0],
        regime: "space",
        hull: 100,
        shields: 50,
        targetId: null,
        classId: "scout",
        callsign: "TEST-ALPHA",
        livery: null,
      },
    ],
  }),
  chat: () => ({ text: "hello world" }),
  input: () => ({
    seq: 1,
    thrust: 0.5,
    turn: -0.1,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    action: null,
  }),
  warp: () => ({ targetSystemId: "system-002" }),
  interact: () => ({ targetId: "node-1", action: "inspect" }),
  mine: () => ({ nodeId: "node-1", duration: 2.5 }),
  sell: () => ({ resourceType: "iron", quantity: 5 }),
  buy_ship: () => ({ classId: "freighter" }),
  set_livery: () => ({
    primary: "#102030",
    secondary: "#abcdef",
    accent: "#f0f0f0",
  }),
  exit_ship: () => ({}),
  enter_ship: () => ({}),
  repair: () => ({}),
  error: () => ({ code: "system-full", message: "16 players already in system" }),
  ping: () => ({ t: 12345.678 }),
  pong: () => ({ t: 12345.678 }),
  presence: () => ({
    systemId: "system-001",
    players: [{ playerId: "p-1", callsign: "TEST-ALPHA", shipId: "ship-1", state: "flying" }],
  }),
  target_update: () => ({
    targetId: "ship-2",
    shields: 25,
    hull: 100,
    bearing: 1.57,
    range: 12.3,
  }),
  combat_event: () => ({
    kind: "hit",
    attacker: "ship-1",
    target: "ship-2",
    weapon: "laser",
    damage: 5.5,
    tick: 42,
  }),
};

// ---------------------------------------------------------------------------
// Malformed example payloads — one per registered message type. Each one
// violates at least one validation rule so the schema *must* reject it.
// ---------------------------------------------------------------------------

const INVALID_PAYLOADS: Record<MessageType, () => unknown> = {
  hello: () => ({ version: -1 }), // negative version
  auth: () => ({}), // neither token nor callsign
  auth_ok: () => ({ playerId: "", callsign: "X", tokenExpiresAt: "not-a-number" }),
  join_system: () => ({ systemId: "" }), // empty
  enter_system: () => ({
    systemId: "system-001",
    entities: [],
    nodes: [],
    chat: [],
    players: [],
    serverTickHz: 0, // invalid (must be positive)
    snapshotTick: 0,
  }),
  state_snapshot: () => ({
    systemId: "system-001",
    tick: -5, // negative
    entities: [],
    nodes: [],
    chat: [],
    players: [],
  }),
  entity_update: () => ({
    systemId: "system-001",
    tick: 0,
    entities: [
      {
        id: "ship-1",
        kind: "ship",
        pos: [0, 0, NaN], // non-finite
        vel: [0, 0, 0],
        regime: "space",
        hull: 100,
        shields: 50,
        targetId: null,
        classId: "scout",
        callsign: null,
        livery: null,
      },
    ],
  }),
  chat: () => ({ text: "" }), // empty text
  input: () => ({
    seq: -1,
    thrust: "x",
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    action: null,
  }),
  warp: () => ({ targetSystemId: "" }),
  interact: () => ({ targetId: "node-1", action: "explode" }), // bad enum
  mine: () => ({ nodeId: "", duration: -1 }),
  sell: () => ({ resourceType: "", quantity: 0 }), // zero/negative quantity
  buy_ship: () => ({ classId: "corvette" }), // unknown class
  set_livery: () => ({ primary: "red", secondary: "#abcdef", accent: "#f0f0f0" }), // bad hex
  exit_ship: () => ({ extra: true }), // strict forbids extra keys
  enter_ship: () => ({ extra: true }),
  repair: () => ({ shipId: "" }),
  error: () => ({ code: "panic", message: "" }), // bad code + empty message
  ping: () => ({ t: NaN }),
  pong: () => ({ t: NaN }),
  presence: () => ({
    systemId: "system-001",
    players: [{ playerId: "", callsign: "X", shipId: null, state: "flying" }],
  }),
  target_update: () => ({ targetId: null, shields: NaN, hull: 0, bearing: 0, range: 0 }),
  combat_event: () => ({
    kind: "destroy", // bad enum
    attacker: "",
    target: "ship-2",
    weapon: "laser",
    damage: -1,
    tick: 0,
  }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const messageTypes = Object.keys(PAYLOAD_SCHEMAS) as MessageType[];

describe("protocol/schemas", () => {
  it("has at least one example per registered type", () => {
    expect(messageTypes.length).toBeGreaterThanOrEqual(22);
    for (const t of messageTypes) {
      expect(typeof VALID_PAYLOADS[t]).toBe("function");
      expect(typeof INVALID_PAYLOADS[t]).toBe("function");
    }
  });

  describe("parametrized: valid payload parses", () => {
    for (const type of messageTypes) {
      it(`accepts a canonical ${type} payload`, () => {
        const payload = VALID_PAYLOADS[type]();
        const schema = PAYLOAD_SCHEMAS[type] as z.ZodType<PayloadFor<typeof type>>;
        const result = schema.safeParse(payload);
        expect(result.success).toBe(true);
      });
    }
  });

  describe("parametrized: invalid payload rejected", () => {
    for (const type of messageTypes) {
      it(`rejects a malformed ${type} payload`, () => {
        const payload = INVALID_PAYLOADS[type]();
        const schema = PAYLOAD_SCHEMAS[type];
        const result = schema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    }
  });

  describe("parseMessage dispatcher", () => {
    it("throws ProtocolError('unknown-type') for an unregistered type", () => {
      try {
        parseMessage("definitely-not-a-type", { foo: "bar" });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolError);
        expect((err as ProtocolError).code).toBe("unknown-type");
      }
    });

    it("throws ProtocolError('invalid-message') for a malformed payload", () => {
      try {
        parseMessage("ping", { t: NaN });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolError);
        expect((err as ProtocolError).code).toBe("invalid-message");
      }
    });

    it("returns a narrowed {type, payload} on success", () => {
      const out = parseMessage("hello", { version: 1 });
      expect(out.type).toBe("hello");
      // payload is typed as Hello; we can read version without a cast.
      expect(out.payload.version).toBe(PROTOCOL_VERSION);
    });
  });

  describe("envelope encode/decode", () => {
    it("round-trips a valid frame", () => {
      const text = encodeEnvelope("ping", { t: 1 });
      const env = decodeEnvelope(text);
      expect(env.v).toBe(PROTOCOL_VERSION);
      expect(env.type).toBe("ping");
      expect(env.payload).toEqual({ t: 1 });
    });

    it("rejects non-JSON input", () => {
      try {
        decodeEnvelope("not-json-at-all");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolError);
        expect((err as ProtocolError).code).toBe("invalid-envelope");
      }
    });

    it("rejects an envelope with the wrong shape", () => {
      try {
        decodeEnvelope(JSON.stringify({ type: "ping", payload: { t: 1 } })); // missing `v`
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolError);
        expect((err as ProtocolError).code).toBe("invalid-envelope");
      }
    });

    it("rejects an envelope with an extra top-level key", () => {
      try {
        decodeEnvelope(JSON.stringify({ v: 1, type: "ping", payload: { t: 1 }, extra: true }));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolError);
        expect((err as ProtocolError).code).toBe("invalid-envelope");
      }
    });
  });
});
