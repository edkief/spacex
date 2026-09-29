import type { z } from 'zod';
import { messageSchemas, type MessageType, type PayloadSchemas } from './protocol/schemas';

export type { MessageType } from './protocol/schemas';

/**
 * WebSocket wire protocol (TASK-9). Versioned envelope, encode/decode helpers
 * and the parseMessage entry point shared by client and server.
 */

/** Bump when the wire format changes incompatibly; clients on other major versions are rejected. */
export const PROTOCOL_VERSION = 1;

/** Keepalive cadence: ping every 15 s, drop after 45 s of silence. */
export const PING_INTERVAL_MS = 15_000;
export const DROP_AFTER_MS = 45_000;

/** A connection is terminated after this many unknown message types. */
export const UNKNOWN_TYPE_DROP_LIMIT = 10;

/** A connection is terminated after this many invalid messages (TASK-64). */
export const INVALID_MESSAGE_DROP_LIMIT = 50;

/** Inbound messages larger than this are rejected before JSON parsing (TASK-64). */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Structured error codes; every server error is {code, message}. */
export const PROTOCOL_ERRORS = {
  VERSION_MISMATCH: 'version-mismatch',
  UNAUTHENTICATED: 'unauthenticated',
  SYSTEM_FULL: 'system-full',
  SYSTEM_NOT_FOUND: 'system-not-found',
  RATE_LIMITED: 'rate-limited',
  INVALID_MESSAGE: 'invalid-message',
  UNKNOWN_TYPE: 'unknown-type',
} as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERRORS)[keyof typeof PROTOCOL_ERRORS];

export interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

export function encodeMessage<T extends MessageType>(
  type: T,
  payload: PayloadSchemas[T],
  v: number = PROTOCOL_VERSION,
): string {
  return JSON.stringify({ v, type, payload } satisfies Envelope);
}

export type DecodedMessage = { ok: true; envelope: Envelope } | { ok: false; message: string };

/** Parse raw socket bytes into an envelope. Never throws. */
export function decodeMessage(data: string | Buffer | Uint8Array): DecodedMessage {
  let text: string;
  try {
    text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  } catch {
    return { ok: false, message: 'undecodable payload' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'message is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'message is not a JSON object' };
  }
  const envelope = raw as Envelope;
  if (typeof envelope.v !== 'number' || !Number.isInteger(envelope.v)) {
    return { ok: false, message: 'envelope.v must be an integer' };
  }
  if (typeof envelope.type !== 'string' || envelope.type.length === 0) {
    return { ok: false, message: 'envelope.type must be a non-empty string' };
  }
  return { ok: true, envelope };
}

/** Typed payload for known message types; `unknown` for unrecognized names. */
export type ParsedPayload<T extends string> = T extends keyof PayloadSchemas
  ? PayloadSchemas[T]
  : unknown;

export type ParseMessageResult<T extends string = string> =
  | { ok: true; type: T; payload: ParsedPayload<T> }
  | { ok: false; code: ProtocolErrorCode; message: string };

/**
 * Validate an inbound envelope's type + payload against the shared registry.
 * Unknown type names yield {code: 'unknown-type'}; schema violations yield
 * {code: 'invalid-message'} with the first failing path.
 */
export function parseMessage<T extends string = string>(
  type: T,
  payload: unknown,
): ParseMessageResult<T> {
  const registry = messageSchemas as unknown as Record<string, z.ZodType>;
  const schema = registry[type];
  if (!schema) {
    return {
      ok: false,
      code: PROTOCOL_ERRORS.UNKNOWN_TYPE,
      message: `unknown message type: ${type}`,
    };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'payload';
    return {
      ok: false,
      code: PROTOCOL_ERRORS.INVALID_MESSAGE,
      message: `${where}: ${issue?.message ?? 'invalid payload'}`,
    };
  }
  return { ok: true, type, payload: result.data as ParsedPayload<T> };
}
