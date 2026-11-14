import { z } from 'zod';
import { callsignSchema } from '../callsign.ts';
import { errorBodySchema } from './errors.ts';
import {
  systemIdSchema,
  timestampSchema,
  tickSchema,
  seqSchema,
  uuidSchema,
} from './primitives.ts';
import { stateSnapshotSchema } from './world.ts';

const version = z.number().int().min(0).max(65535);
const timeStamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const helloSchema = z.strictObject({ v: version });
export const welcomeSchema = z.strictObject({
  v: version,
  tickRate: z.number().int().min(1).max(240),
  snapshotRate: z.number().int().min(1).max(240),
  serverTime: timeStamp,
});

/** Session tokens are opaque base64url strings; callsigns are claimed over REST, not here. */
export const authSchema = z.strictObject({ token: z.string().min(1).max(512) });
export const authOkSchema = z.strictObject({
  playerId: uuidSchema,
  callsign: callsignSchema,
  shipId: uuidSchema,
  homeSystemId: systemIdSchema,
});

export const logoutSchema = z.strictObject({});
export const joinSystemSchema = z.strictObject({ systemId: systemIdSchema });
export const enterSystemSchema = z.strictObject({
  systemId: systemIdSchema,
  tick: tickSchema,
  lastInputSeq: seqSchema,
  snapshot: stateSnapshotSchema,
});

export const pingSchema = z.strictObject({ t: timestampSchema });
export const pongSchema = z.strictObject({ t: timestampSchema });
export const errorSchema = errorBodySchema;
