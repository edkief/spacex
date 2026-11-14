import { z } from 'zod';
import { errorBody, type ErrorBody } from './errors.ts';
import {
  CLIENT_MESSAGES,
  SERVER_MESSAGES,
  isClientType,
  isServerType,
  type ClientMessage,
  type ServerMessage,
} from './registry.ts';

export const PROTOCOL_VERSION = 1;
/** Largest frame accepted or produced, in bytes. Enforced by ws `maxPayload` as well. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** Failures carry the client-facing error plus server-side `issues` (paths only, never values). */
export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: ErrorBody; issues?: string[] };

/** Summarises zod issues as `path:code` strings that are safe to log (no payload values). */
function issuePaths(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`);
}

/** Envelope = {v, type, payload}; `payload` is validated later against the type's schema. */
export const envelopeSchema = z.strictObject({
  v: z.number().int().min(0).max(65535),
  type: z.string().min(1).max(40),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** Serialises a message as a JSON text frame. */
export function encodeMessage<T extends string, P>(type: T, payload: P): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, payload });
}

/** Parses frame text into an envelope without throwing. */
export function decodeEnvelope(text: string): ParseResult<Envelope> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: errorBody('invalid-message', 'frame is not valid JSON'),
      issues: ['json'],
    };
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: errorBody('invalid-message', 'frame is not a valid envelope'),
      issues: issuePaths(parsed.error),
    };
  }
  return { ok: true, value: parsed.data };
}

/** Validates a payload against the client registry (the only registry the server parses). */
export function parseClientMessage(type: string, payload: unknown): ParseResult<ClientMessage> {
  if (!isClientType(type))
    return { ok: false, error: errorBody('unknown-type', 'unknown message type') };
  const parsed = CLIENT_MESSAGES[type].safeParse(payload);
  if (!parsed.success)
    return {
      ok: false,
      error: errorBody('invalid-message', `invalid ${type} payload`),
      issues: issuePaths(parsed.error),
    };
  return { ok: true, value: { type, payload: parsed.data } as ClientMessage };
}

/** Validates a payload against the server registry (the only registry the client parses). */
export function parseServerMessage(type: string, payload: unknown): ParseResult<ServerMessage> {
  if (!isServerType(type))
    return { ok: false, error: errorBody('unknown-type', 'unknown message type') };
  const parsed = SERVER_MESSAGES[type].safeParse(payload);
  if (!parsed.success)
    return {
      ok: false,
      error: errorBody('invalid-message', `invalid ${type} payload`),
      issues: issuePaths(parsed.error),
    };
  return { ok: true, value: { type, payload: parsed.data } as ServerMessage };
}

/** Which registry a message travels through. */
export type Direction = 'c2s' | 's2c';

/** Spec helper: validate `payload` for `type` in the given direction. */
export function parseMessage(
  direction: Direction,
  type: string,
  payload: unknown,
): ParseResult<ClientMessage | ServerMessage> {
  return direction === 'c2s'
    ? parseClientMessage(type, payload)
    : parseServerMessage(type, payload);
}

/** Decodes frame text and validates it as a client message in one step (used by tests/tools). */
export function decodeClientFrame(text: string): ParseResult<ClientMessage> {
  const envelope = decodeEnvelope(text);
  if (!envelope.ok) return envelope;
  return parseClientMessage(envelope.value.type, envelope.value.payload);
}
