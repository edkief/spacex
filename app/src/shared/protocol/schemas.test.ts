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

import {
  PAYLOAD_SCHEMAS,
  EntityStateSchema,
  ErrorCodeSchema,
  type MessageType,
  type PayloadFor,
} from "./schemas.js";
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
        onPad: null,
        // TASK-31: `onFoot` is optional and absent on ship
        // entities. The shape still validates without it so
        // pre-TASK-31 clients continue to work.
      },
      {
        id: "char-1",
        kind: "character",
        pos: [2.5, 0, 0],
        vel: [0, 0, 0],
        regime: "surface",
        hull: 0,
        shields: 0,
        targetId: null,
        classId: null,
        callsign: "TEST-ALPHA",
        livery: null,
        onPad: "pad-0-0",
        onFoot: true,
      },
    ],
    lastAppliedSeq: { "player-1": 7 },
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
  warp_arrived: () => ({
    targetSystemId: "system-002",
    systemId: "system-002",
    entities: [],
    nodes: [],
    chat: [],
    players: [],
    serverTickHz: 20,
    snapshotTick: 0,
  }),
  interact: () => ({ targetId: "node-1", action: "inspect" }),
  interact_ok: () => ({ targetId: "node-1", action: "use" }),
  ui_open: () => ({ ui: "dock", payload: { station: "alpha" } }),
  pickup: () => ({ targetId: "node-1" }),
  drop: () => ({ resourceType: "iron", amount: 5 }),
  inventory_update: () => ({
    stacks: { iron: 5 },
    weightUsed: 5,
    capacity: 40,
    action: "pickup-full",
    taken: 5,
    remaining: 0,
  }),
  mine: () => ({ nodeId: "node-1", duration: 2.5 }),
  mine_stop: () => ({}),
  mining_update: () => ({
    depositId: "node-1",
    resourceId: "iron",
    progressMs: 750,
    unitsSoFar: 2,
    amount: 18,
    state: "mining",
  }),
  sell: () => ({ resourceType: "iron", quantity: 5 }),
  cargo_transfer: () => ({ resourceId: "iron", amount: 5, from: "inv" }),
  cargo_update: () => ({
    cargo: { stacks: { iron: 5 }, weightUsed: 5, capacity: 40 },
    inventory: { stacks: {}, weightUsed: 0, capacity: 40 },
    direction: "inv",
    resourceId: "iron",
    transferred: 5,
    remaining: 0,
    action: "move-to-hold",
  }),
  buy_ship: () => ({ classId: "freighter" }),
  set_livery: () => ({
    primary: "#102030",
    secondary: "#abcdef",
    accent: "#f0f0f0",
  }),
  exit_ship: () => ({}),
  enter_ship: () => ({}),
  enter_ship_ok: () => ({ shipId: "ship-test-1" }),
  repair: () => ({}),
  logout: () => ({}),
  logout_ok: () => ({ callsign: "TEST-ALPHA" }),
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
    kind: "damaged",
    target: "ship-2",
    source: { kind: "player", id: "ship-1" },
    amount: 30,
    shieldHit: 30,
    hullHit: 0,
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
  warp_arrived: () => ({
    targetSystemId: "system-002",
    systemId: "system-002",
    entities: [],
    nodes: [],
    chat: [],
    players: [],
    serverTickHz: 0, // invalid — must be positive
    snapshotTick: -1, // invalid — must be non-negative
  }),
  interact: () => ({ targetId: "node-1", action: "explode" }), // bad enum
  interact_ok: () => ({ targetId: "", action: "explode" }), // empty targetId + bad enum
  ui_open: () => ({ ui: "menu", payload: { x: 1 } }), // unknown `ui`
  pickup: () => ({ targetId: "" }), // empty
  drop: () => ({ resourceType: "iron", amount: -3 }), // negative amount
  inventory_update: () => ({
    stacks: { iron: -1 }, // negative stack
    weightUsed: 0,
    capacity: 40,
    action: "pickup-full",
    taken: 0,
    remaining: 0,
  }),
  mine: () => ({ nodeId: "", duration: -1 }),
  mine_stop: () => ({ extra: true }), // strict forbids extra keys
  mining_update: () => ({
    depositId: "",
    resourceId: "iron",
    progressMs: -1, // negative
    unitsSoFar: 0,
    amount: 0,
    state: "mining",
  }),
  sell: () => ({ resourceType: "", quantity: 0 }), // zero/negative quantity
  cargo_transfer: () => ({ resourceId: "iron", amount: 0, from: "inv" }), // zero amount
  cargo_update: () => ({
    cargo: { stacks: { iron: -1 }, weightUsed: 0, capacity: 40 }, // negative stack
    inventory: { stacks: {}, weightUsed: 0, capacity: 40 },
    direction: "sideways", // bad enum
    resourceId: "iron",
    transferred: 0,
    remaining: 0,
    action: "move-to-hold",
  }),
  buy_ship: () => ({ classId: "corvette" }), // unknown class
  set_livery: () => ({ primary: "red", secondary: "#abcdef", accent: "#f0f0f0" }), // bad hex
  exit_ship: () => ({ extra: true }), // strict forbids extra keys
  enter_ship: () => ({ extra: true }),
  enter_ship_ok: () => ({ shipId: "" }), // empty shipId rejected
  repair: () => ({ shipId: "" }),
  logout: () => ({ extra: true }), // strict forbids extra keys
  logout_ok: () => ({ callsign: "" }), // empty string rejected
  error: () => ({ code: "panic", message: "" }), // bad code + empty message
  // TASK-31: extra VALID example for the `not-docked` code we
  // added to the enum. The default `VALID_PAYLOADS` only carries
  // one canonical error example; the not-docked variant is the
  // wire code the disembark handler emits on a rejection.
  ping: () => ({ t: NaN }),
  pong: () => ({ t: NaN }),
  presence: () => ({
    systemId: "system-001",
    players: [{ playerId: "", callsign: "X", shipId: null, state: "flying" }],
  }),
  target_update: () => ({ targetId: null, shields: NaN, hull: 0, bearing: 0, range: 0 }),
  combat_event: () => ({
    kind: "damaged",
    target: "",
    source: { kind: "player", id: "" },
    amount: -1, // negative damage is rejected
    shieldHit: 0,
    hullHit: 0,
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

  // -------------------------------------------------------------------------
  // TASK-31: not-docked wire code + character entity shape.
  // -------------------------------------------------------------------------

  describe("not-docked error code (TASK-31)", () => {
    it("accepts an error frame with code: 'not-docked'", () => {
      const result = ErrorCodeSchema.safeParse("not-docked");
      expect(result.success).toBe(true);
    });

    it("rejects an unknown error code", () => {
      const result = ErrorCodeSchema.safeParse("panic-at-the-disc0");
      expect(result.success).toBe(false);
    });

    it("an error frame with not-docked round-trips through parseMessage", () => {
      const out = parseMessage("error", {
        code: "not-docked",
        message: "Ship is not docked",
      });
      expect(out.type).toBe("error");
      expect(out.payload.code).toBe("not-docked");
    });
  });

  // -------------------------------------------------------------------------
  // TASK-35: re-entry wire codes (not-owner / ship-moving / already-in-ship).
  // -------------------------------------------------------------------------

  describe("re-entry error codes (TASK-35)", () => {
    it("accepts each new error code", () => {
      for (const code of ["not-owner", "ship-moving", "already-in-ship"] as const) {
        const result = ErrorCodeSchema.safeParse(code);
        expect(result.success).toBe(true);
      }
    });

    it("round-trips each new code through parseMessage", () => {
      for (const code of ["not-owner", "ship-moving", "already-in-ship"] as const) {
        const out = parseMessage("error", {
          code,
          message: `re-entry rejected: ${code}`,
        });
        expect(out.type).toBe("error");
        if (out.type !== "error") throw new Error("unreachable");
        expect(out.payload.code).toBe(code);
      }
    });

    it("enter_ship_ok round-trips a shipId payload", () => {
      const out = parseMessage("enter_ship_ok", { shipId: "ship-test-1" });
      expect(out.type).toBe("enter_ship_ok");
      if (out.type !== "enter_ship_ok") throw new Error("unreachable");
      expect(out.payload.shipId).toBe("ship-test-1");
    });
  });

  describe("character entity shape (TASK-31)", () => {
    it("accepts a character entity with onFoot: true", () => {
      const result = EntityStateSchema.safeParse({
        id: "char-1",
        kind: "character",
        pos: [2.5, 0, 0],
        vel: [0, 0, 0],
        regime: "surface",
        hull: 0,
        shields: 0,
        targetId: null,
        classId: null,
        callsign: "TEST-ALPHA",
        livery: null,
        onPad: "pad-0-0",
        onFoot: true,
      });
      expect(result.success).toBe(true);
    });

    it("accepts a character entity without onFoot (older clients)", () => {
      const result = EntityStateSchema.safeParse({
        id: "char-1",
        kind: "character",
        pos: [2.5, 0, 0],
        vel: [0, 0, 0],
        regime: "surface",
        hull: 0,
        shields: 0,
        targetId: null,
        classId: null,
        callsign: "TEST-ALPHA",
        livery: null,
        onPad: "pad-0-0",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a character entity with onFoot: 'yes' (wrong type)", () => {
      const result = EntityStateSchema.safeParse({
        id: "char-1",
        kind: "character",
        pos: [0, 0, 0],
        vel: [0, 0, 0],
        regime: "surface",
        hull: 0,
        shields: 0,
        targetId: null,
        classId: null,
        callsign: null,
        livery: null,
        onPad: null,
        onFoot: "yes",
      });
      expect(result.success).toBe(false);
    });
  });
});
