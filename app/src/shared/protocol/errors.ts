import { z } from 'zod';

/** Every error code the server can return, over REST or WebSocket. */
export const ERROR_CODES = [
  'version-mismatch',
  'unauthenticated',
  'system-full',
  'system-not-found',
  'rate-limited',
  'invalid-message',
  'unknown-type',
  'not-implemented',
  'out-of-order',
  'too-many-connections',
  'forbidden-origin',
  'invalid-request',
  'callsign-taken',
  'not-found',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The one error shape, identical for REST responses and WebSocket `error` messages. */
export const errorBodySchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string().max(300),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

/** WebSocket close codes (4000-4999 are application-defined). */
export const CLOSE_CODES = {
  versionMismatch: 4000,
  handshakeTimeout: 4001,
  loggedOut: 1000,
  connectionLimit: 4008,
  flooded: 4009,
  heartbeatTimeout: 4010,
  tooManyInvalid: 4011,
  tooManyUnknown: 4012,
  serverShutdown: 1001,
} as const;

/** Builds an error body. */
export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { code, message };
}
