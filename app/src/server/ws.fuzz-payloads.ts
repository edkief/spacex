/**
 * 20+ crafted malformed payload catalogue (TASK-64 fuzz acceptance).
 *
 * Each payload targets a specific branch of the dispatcher:
 *   - envelope shape (missing/extra fields, wrong types, non-JSON)
 *   - per-type schema validation (NaN/Infinity, empty strings, oversize,
 *     negative numbers, unknown enums)
 *   - strict-mode violations (unknown keys on typed objects)
 *   - deeply nested objects that no registered schema matches
 *
 * Kept in its own file so the full payload library is easy to scan in
 * code review — adding a new case is a one-line edit here that doesn't
 * tangle with harness plumbing.
 */
import { PROTOCOL_VERSION } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface FuzzPayload {
  name: string;
  raw: string;
  /**
   * Which ProtocolError code we expect in the `error` frame. Most payloads
   * map to `invalid-message`; the dedicated unknown-type case maps to
   * `unknown-type`; non-JSON bytes also map to `invalid-message` because
   * the dispatcher forwards envelope-decode failures under that code
   * (clients only see one validation code).
   */
  expectCode: string;
}

// ---------------------------------------------------------------------------
// Payload-building helpers
// ---------------------------------------------------------------------------

/** Build a deeply-nested object of `depth` levels that no schema matches. */
export function nestedObject(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i++) {
    obj = { nest: obj };
  }
  return obj;
}

/** Build a string of `bytes` characters. Used for oversize frames. */
export function byteString(bytes: number): string {
  return "x".repeat(bytes);
}

// ---------------------------------------------------------------------------
// Payload catalogue
// ---------------------------------------------------------------------------

/**
 * 20 crafted malformed payloads covering the TASK-64 acceptance families
 * (wrong types, NaN, Infinity, depth-30 nesting, oversize, negative seq,
 * unknown fields where strict forbids). Order matters for diagnostic
 * output: the test asserts the i-th response matches the i-th payload.
 */
export const FUZZ_PAYLOADS: FuzzPayload[] = [
  {
    name: "non-JSON garbage",
    raw: "definitely not json",
    expectCode: "invalid-message",
  },
  {
    name: "empty body",
    raw: "",
    expectCode: "invalid-message",
  },
  {
    name: "JSON null",
    raw: "null",
    expectCode: "invalid-message",
  },
  {
    name: "JSON array at top level (envelope is an object, not array)",
    raw: "[]",
    expectCode: "invalid-message",
  },
  {
    name: "envelope missing v",
    raw: JSON.stringify({ type: "hello", payload: { version: PROTOCOL_VERSION } }),
    expectCode: "invalid-message",
  },
  {
    name: "envelope missing type",
    raw: JSON.stringify({ v: PROTOCOL_VERSION, payload: { version: PROTOCOL_VERSION } }),
    expectCode: "invalid-message",
  },
  {
    name: "envelope missing payload",
    raw: JSON.stringify({ v: PROTOCOL_VERSION, type: "hello" }),
    expectCode: "invalid-message",
  },
  {
    name: "envelope with unknown top-level key (strict forbids)",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "hello",
      payload: { version: PROTOCOL_VERSION },
      extra: "sneaky",
    }),
    expectCode: "invalid-message",
  },
  {
    name: "v must be int (string provided)",
    raw: JSON.stringify({
      v: "1",
      type: "hello",
      payload: { version: PROTOCOL_VERSION },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "v must be non-negative (-1 provided)",
    raw: JSON.stringify({ v: -1, type: "hello", payload: { version: PROTOCOL_VERSION } }),
    expectCode: "invalid-message",
  },
  {
    name: "unknown message type (dedicated error code)",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "definitely-not-registered",
      payload: { whatever: 1 },
    }),
    expectCode: "unknown-type",
  },
  {
    name: "hello payload with NaN",
    raw: JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { version: NaN } }),
    expectCode: "invalid-message",
  },
  {
    name: "input payload with NaN thrust",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "input",
      payload: {
        seq: 1,
        thrust: NaN,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
        action: null,
      },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "input payload with +Infinity",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "input",
      payload: {
        seq: 1,
        thrust: Infinity,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
        action: null,
      },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "chat payload with empty string (min-length is 1)",
    raw: JSON.stringify({ v: PROTOCOL_VERSION, type: "chat", payload: { text: "" } }),
    expectCode: "invalid-message",
  },
  {
    name: "chat payload with 600-char string (max-length is 500)",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "chat",
      payload: { text: "a".repeat(600) },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "input payload with negative seq",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "input",
      payload: {
        seq: -1,
        thrust: 0.5,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
        action: null,
      },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "interact payload with unknown enum value",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "interact",
      payload: { targetId: "node-1", action: "explode" },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "set_livery payload with unknown key (strict forbids)",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "set_livery",
      payload: {
        primary: "#102030",
        secondary: "#abcdef",
        accent: "#f0f0f0",
        sneaky: true,
      },
    }),
    expectCode: "invalid-message",
  },
  {
    name: "30-deep nested object (no registered schema matches)",
    raw: JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "input",
      payload: nestedObject(30),
    }),
    expectCode: "invalid-message",
  },
];

/**
 * Pinned list of payload names the TASK-64 acceptance criteria require.
 * The test asserts each is present so an accidental deletion of a
 * targeted case fails loudly rather than silently reducing coverage.
 */
export const REQUIRED_FUZZ_NAMES: readonly string[] = [
  "non-JSON garbage",
  "empty body",
  "envelope missing v",
  "envelope with unknown top-level key (strict forbids)",
  "unknown message type (dedicated error code)",
  "hello payload with NaN",
  "input payload with +Infinity",
  "chat payload with 600-char string (max-length is 500)",
  "input payload with negative seq",
  "interact payload with unknown enum value",
  "set_livery payload with unknown key (strict forbids)",
  "30-deep nested object (no registered schema matches)",
] as const;
