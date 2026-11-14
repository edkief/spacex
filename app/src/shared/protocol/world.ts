import { z } from 'zod';
import { callsignSchema } from '../callsign.ts';
import { REGIMES } from '../regime.ts';
import { liverySchema } from '../ships/livery.ts';
import {
  entityIdSchema,
  framePositionSchema,
  hex16Schema,
  printable,
  quatSchema,
  seqSchema,
  shipClassIdSchema,
  statSchema,
  tickSchema,
  timestampSchema,
  uuidSchema,
  vec3Schema,
} from './primitives.ts';

export const entityKindSchema = z.enum(['ship', 'character', 'ai-ship', 'wreck']);
/** Where an entity currently lives; refined by the flight/regime tasks. */
export const regimeSchema = z.enum(REGIMES);

/** One shape for all snapshot traffic. `classId` is null for characters. */
export const entityStateSchema = z.strictObject({
  id: entityIdSchema,
  kind: entityKindSchema,
  pos: framePositionSchema,
  vel: vec3Schema,
  quat: quatSchema,
  regime: regimeSchema,
  hull: statSchema,
  shields: statSchema,
  targetId: entityIdSchema.nullable(),
  classId: shipClassIdSchema.nullable(),
  callsign: callsignSchema.optional(),
  livery: liverySchema.optional(),
});

export const nodeInfoSchema = z.strictObject({
  nodeId: hex16Schema,
  type: printable(32),
  pos: framePositionSchema,
  quantity: z.number().int().min(0).max(2147483647),
});

export const chatLineSchema = z.strictObject({
  from: callsignSchema,
  text: printable(280),
  at: timestampSchema,
});

export const playerInfoSchema = z.strictObject({
  playerId: uuidSchema,
  callsign: callsignSchema,
  entityId: entityIdSchema.nullable(),
});

/** Full state of a system as seen by one recipient. */
export const stateSnapshotSchema = z.strictObject({
  systemId: hex16Schema,
  tick: tickSchema,
  lastInputSeq: seqSchema,
  entities: z.array(entityStateSchema).max(512),
  nodes: z.array(nodeInfoSchema).max(512),
  chat: z.array(chatLineSchema).max(100),
  players: z.array(playerInfoSchema).max(64),
});

/** Incremental update; `lastInputSeq` is the newest input the server applied for this recipient. */
export const entityUpdateSchema = z.strictObject({
  tick: tickSchema,
  lastInputSeq: seqSchema,
  entities: z.array(entityStateSchema).max(512),
});

const axis = z.number().min(-1).max(1);

/** Flight input. `seq` must increase strictly within a connection. */
export const inputSchema = z.strictObject({
  seq: seqSchema,
  thrust: axis,
  turn: axis,
  pitch: axis,
  yaw: axis,
  fire: z.boolean(),
  lock: z.boolean(),
  action: z.enum(['none', 'boost', 'brake', 'dock', 'undock']),
});

export const warpSchema = z.strictObject({ targetSystemId: hex16Schema });
export const targetUpdateClientSchema = z.strictObject({ targetId: entityIdSchema.nullable() });
export const targetUpdateServerSchema = z.strictObject({
  entityId: entityIdSchema,
  targetId: entityIdSchema.nullable(),
});

export const presenceSchema = z.strictObject({
  joined: z.array(playerInfoSchema).max(64),
  left: z.array(uuidSchema).max(64),
});

export const combatEventSchema = z.strictObject({
  tick: tickSchema,
  kind: z.enum(['hit', 'kill']),
  attacker: entityIdSchema,
  target: entityIdSchema,
  weapon: z.enum(['laser', 'missile', 'collision']),
  damage: statSchema,
});
