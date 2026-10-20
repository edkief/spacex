/**
 * Drift WebSocket protocol — versioned, typed message envelope (TASK-9).
 *
 * Every frame on the wire is a JSON object of the shape:
 *
 *     { v: number, type: string, payload: unknown }
 *
 * The `v` field is the protocol version; both peers refuse to talk to each
 * other if their `v` does not match. `type` is a string discriminator
 * (one of the keys of `PAYLOAD_SCHEMAS`) and `payload` is the type-specific
 * body, validated by a zod schema.
 *
 * This module is the only thing both the client and the server import to
 * send/receive/validate frames; the schemas live in `./schemas.ts` and are
 * re-exported from here for ergonomic `import { … } from "@shared/protocol"`
 * usage.
 *
 * Public API:
 *   - `PROTOCOL_VERSION`         — current wire version (bumped on breaks)
 *   - `MessageType` / `MESSAGE_TYPES`
 *   - `PAYLOAD_SCHEMAS` / `PayloadFor<T>`
 *   - `EnvelopeSchema`, `Envelope` — wire frame schema + type
 *   - `decodeEnvelope(json)`      — parses a raw string into a typed envelope
 *   - `encodeEnvelope(type, payload)` — serialises an outbound frame
 *   - `parseMessage(type, payload)` — narrows + validates a payload
 *   - `ProtocolError`             — thrown by `parseMessage` on bad input
 */
import { z } from "zod";

import { PAYLOAD_SCHEMAS, type MessageType, type PayloadFor } from "./schemas.js";

// ---------------------------------------------------------------------------
// Version + envelope
// ---------------------------------------------------------------------------

/**
 * Current wire-protocol version. Bump this value (and add a migration note
 * in `.ralph/tasks/TASK-69.json` once the docs task lands) when an envelope
 * change is not backward-compatible.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Wire envelope schema. `v` is the protocol version, `type` is the message
 * discriminator, `payload` is the (unparsed) body that `parseMessage` will
 * narrow into a concrete type.
 *
 * `.strict()` rejects unknown top-level keys so a typo (`{version: …}`
 * instead of `{v: …}`) fails fast instead of being silently dropped.
 */
export const EnvelopeSchema = z
  .object({
    v: z.number().int().nonnegative(),
    type: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;

// ---------------------------------------------------------------------------
// ProtocolError — thrown by parseMessage on bad input
// ---------------------------------------------------------------------------

/**
 * Discriminated error thrown by `parseMessage` when validation fails.
 * The server converts this to a `{ type: "error", payload: { code, message } }`
 * frame so the client gets a structured failure rather than a connection drop.
 *
 * `code` is one of `ProtocolErrorCode` from `./schemas.ts`; `message` is
 * a developer-facing explanation suitable for logs (it is *not* shown to
 * end users without sanitisation).
 */
export class ProtocolError extends Error {
  public readonly code:
    "invalid-message" | "unknown-type" | "version-mismatch" | "invalid-envelope";

  constructor(
    code: "invalid-message" | "unknown-type" | "version-mismatch" | "invalid-envelope",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/**
 * Type guard that narrows `value` to a `MessageType`. Used by the server
 * to keep the unknown-type counter and decide whether to drop a connection.
 */
export function isMessageType(value: string): value is MessageType {
  return Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, value);
}

/**
 * Narrow `type` and validate `payload` against the per-type zod schema.
 *
 * Throws:
 *   - `ProtocolError("unknown-type", …)` when `type` is not registered.
 *   - `ProtocolError("invalid-message", …)` when validation fails.
 *
 * The returned object is `{ type: MessageType; payload: PayloadFor<Type> }`,
 * so callers can rely on the type-narrowed payload without re-asserting.
 */
export function parseMessage<T extends MessageType>(
  type: T,
  payload: unknown,
): { type: T; payload: PayloadFor<T> };
export function parseMessage(
  type: string,
  payload: unknown,
): { type: MessageType; payload: unknown };
export function parseMessage(
  type: string,
  payload: unknown,
): { type: MessageType; payload: unknown } {
  if (!isMessageType(type)) {
    throw new ProtocolError("unknown-type", `Unknown message type: ${type}`);
  }
  const schema = PAYLOAD_SCHEMAS[type];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "validation failed";
    throw new ProtocolError("invalid-message", `Invalid payload for ${type}: ${issue}`);
  }
  return { type, payload: parsed.data as unknown };
}

// ---------------------------------------------------------------------------
// Encode / decode helpers
// ---------------------------------------------------------------------------

/**
 * Serialise an outbound frame. Stamps the current `PROTOCOL_VERSION` into
 * the `v` field and JSON-encodes the envelope. Throws if `payload` is not
 * serialisable (e.g. contains a circular reference).
 *
 * Type-checked via overloads so the caller gets the right payload type
 * for the chosen `type`.
 */
export function encodeEnvelope<T extends MessageType>(type: T, payload: PayloadFor<T>): string;
export function encodeEnvelope(type: MessageType, payload: unknown): string;
export function encodeEnvelope(type: MessageType, payload: unknown): string {
  // We intentionally do *not* run `parseMessage` here — callers should
  // already have a typed payload; if not, the underlying JSON.stringify
  // failure surfaces a clear error to the developer.
  return JSON.stringify({ v: PROTOCOL_VERSION, type, payload });
}

/**
 * Parse a raw string into a typed `Envelope`. Throws `ProtocolError("invalid-envelope")`
 * when the JSON is malformed or the envelope shape is wrong. The `payload`
 * is left as `unknown` so the caller can pipe it into `parseMessage`.
 *
 * This is the inbound counterpart to `encodeEnvelope`; both ends of a
 * connection should run their inputs through it.
 */
export function decodeEnvelope(raw: string | Buffer): Envelope {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(
      "invalid-envelope",
      `Envelope is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = EnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]?.message ?? "envelope shape mismatch";
    throw new ProtocolError("invalid-envelope", `Envelope validation failed: ${issue}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Re-exports from schemas.ts
// ---------------------------------------------------------------------------

export { PAYLOAD_SCHEMAS, MESSAGE_TYPES, type MessageType, type PayloadFor } from "./schemas.js";

export {
  // Shared sub-schemas (handy for downstream consumers)
  Vec3Schema,
  ShipClassIdSchema,
  EntityKindSchema,
  RegimeSchema,
  PlayerActivitySchema,
  LiverySchema,
  EntityStateSchema,
  ChatEntrySchema,
  NodeSnapshotSchema,
  PresenceEntrySchema,
  ErrorCodeSchema,
  // Per-message-type schemas
  HelloSchema,
  AuthSchema,
  AuthOkSchema,
  JoinSystemSchema,
  EnterSystemSchema,
  StateSnapshotSchema,
  EntityUpdateSchema,
  ChatSchema,
  InputSchema,
  WarpSchema,
  WarpArrivedSchema,
  InteractSchema,
  InteractOkSchema,
  PickupSchema,
  DropSchema,
  InventoryUpdateSchema,
  InventoryStacksSchema,
  UiOpenSchema,
  MineSchema,
  SellSchema,
  BuyShipSchema,
  SetLiverySchema,
  ExitShipSchema,
  EnterShipSchema,
  EnterShipOkSchema,
  RepairSchema,
  LogoutSchema,
  LogoutOkSchema,
  ErrorSchema,
  PingSchema,
  PongSchema,
  PresenceSchema,
  TargetUpdateSchema,
  CombatEventSchema,
  HazardCellWireSchema,
  HazardUpdateSchema,
  type ProtocolCombatEvent,
  // Inferred types
  type ProtocolInventoryUpdate,
  type Vec3,
  type ProtocolShipClassId,
  type ProtocolEntityKind,
  type ProtocolRegime,
  type ProtocolPlayerActivity,
  type ProtocolEntityState,
  type ProtocolErrorCode,
} from "./schemas.js";
