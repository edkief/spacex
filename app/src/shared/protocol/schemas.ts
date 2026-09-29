import { z } from 'zod';

/**
 * Shared payload schemas for the client↔server WebSocket protocol (TASK-9).
 * One zod schema per message type; imported by both client and server so the
 * wire contract has a single source of truth (names are stable — TASK-69 docs).
 */

export const ENTITY_KINDS = ['ship', 'character', 'ai-ship', 'wreck'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const REGIMES = ['sublight', 'cruise', 'warp', 'docked'] as const;
export type Regime = (typeof REGIMES)[number];

export const CHAT_CHANNELS = ['local', 'system'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

export const COMBAT_EVENT_KINDS = ['hit', 'kill'] as const;
export type CombatEventKind = (typeof COMBAT_EVENT_KINDS)[number];

export const PRESENCE_EVENTS = ['join', 'leave'] as const;
export type PresenceEvent = (typeof PRESENCE_EVENTS)[number];

/** Finite numbers only — NaN/Infinity never cross the wire. */
const finite = z.number().finite();

export const vec3Schema = z.object({ x: finite, y: finite, z: finite }).strict();
export type Vec3 = z.infer<typeof vec3Schema>;

export const liverySchema = z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/));
export type Livery = z.infer<typeof liverySchema>;

/** One shape for all snapshot traffic (spec technical note). */
export const entityStateSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(ENTITY_KINDS),
    pos: vec3Schema,
    vel: vec3Schema,
    regime: z.enum(REGIMES),
    hull: finite.min(0).max(1),
    shields: finite.min(0).max(1),
    targetId: z.string().min(1).nullable(),
    classId: z.string().min(1),
    callsign: z.string().min(1).max(24).optional(),
    livery: liverySchema.optional(),
  })
  .strict();
export type EntityState = z.infer<typeof entityStateSchema>;

export const resourceNodeSchema = z
  .object({
    id: z.string().min(1),
    planetId: z.string().min(1),
    type: z.string().min(1),
    pos: vec3Schema,
    quantity: z.number().int().finite().min(0),
  })
  .strict();
export type ResourceNode = z.infer<typeof resourceNodeSchema>;

export const chatMessageSchema = z
  .object({
    id: z.string().min(1),
    authorId: z.string().min(1),
    callsign: z.string().min(1).max(24),
    channel: z.enum(CHAT_CHANNELS),
    text: z.string().max(256),
    ts: z.string().min(1),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const presenceEntrySchema = z
  .object({
    playerId: z.string().min(1),
    callsign: z.string().min(1).max(24),
    shipId: z.string().min(1).optional(),
  })
  .strict();
export type PresenceEntry = z.infer<typeof presenceEntrySchema>;

/** Full world state for a system; chat holds only the last 100 messages. */
export const stateSnapshotSchema = z
  .object({
    systemId: z.string().min(1),
    entities: z.array(entityStateSchema).max(1000),
    nodes: z.array(resourceNodeSchema).max(1000),
    chat: z.array(chatMessageSchema).max(100),
    players: z.array(presenceEntrySchema).max(100),
  })
  .strict();
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

/**
 * The type registry: message type name → payload schema.
 * The server validates every inbound envelope against this; the client uses
 * the same record to type its send helpers.
 * Every payload schema is .strict(): unknown fields are rejected, not
 * stripped, so field-spraying probes fail validation (TASK-64).
 */
export const messageSchemas = {
  hello: z.object({ v: z.number().int() }).strict(),
  auth: z
    .object({
      token: z.string().min(1).max(512).optional(),
      callsign: z.string().min(1).max(24).optional(),
    })
    .strict()
    .refine((p) => p.token !== undefined || p.callsign !== undefined, {
      message: 'auth requires a token or a callsign',
    }),
  join_system: z.object({ systemId: z.string().min(1).max(64) }).strict(),
  enter_system: z.object({ snapshot: stateSnapshotSchema }).strict(),
  state_snapshot: stateSnapshotSchema,
  entity_update: z.object({ entities: z.array(entityStateSchema).min(1).max(1000) }).strict(),
  chat: z
    .object({
      channel: z.enum(CHAT_CHANNELS).default('local'),
      text: z.string().min(1).max(256),
    })
    .strict(),
  input: z
    .object({
      seq: z.number().int().finite().nonnegative(),
      thrust: finite,
      turn: finite,
      pitch: finite,
      yaw: finite,
      fire: z.boolean(),
      lock: z.boolean(),
      action: z.string().min(1).max(64).optional(),
    })
    .strict(),
  warp: z.object({ destinationSystemId: z.string().min(1).max(64) }).strict(),
  interact: z.object({ targetId: z.string().min(1), action: z.string().min(1).max(32) }).strict(),
  mine: z.object({ nodeId: z.string().min(1) }).strict(),
  sell: z
    .object({ cargoId: z.string().min(1), quantity: z.number().int().finite().positive() })
    .strict(),
  buy_ship: z.object({ classId: z.string().min(1).max(32) }).strict(),
  set_livery: z.object({ livery: liverySchema }).strict(),
  exit_ship: z.object({ shipId: z.string().min(1) }).strict(),
  enter_ship: z.object({ shipId: z.string().min(1) }).strict(),
  repair: z.object({}).strict(),
  error: z.object({ code: z.string().min(1), message: z.string().max(512) }).strict(),
  ping: z.object({}).strict(),
  pong: z.object({}).strict(),
  presence: z
    .object({
      event: z.enum(PRESENCE_EVENTS),
      player: presenceEntrySchema,
    })
    .strict(),
  target_update: z.object({ targetId: z.string().min(1).nullable() }).strict(),
  combat_event: z
    .object({
      kind: z.enum(COMBAT_EVENT_KINDS),
      attacker: z.string().min(1),
      target: z.string().min(1),
      weapon: z.string().min(1),
      damage: finite.min(0),
    })
    .strict(),
} as const;

export type MessageType = keyof typeof messageSchemas;

/** Parsed payload types, keyed by message type. */
export type PayloadSchemas = { [K in MessageType]: z.infer<(typeof messageSchemas)[K]> };

export type HelloPayload = PayloadSchemas['hello'];
export type AuthPayload = PayloadSchemas['auth'];
export type JoinSystemPayload = PayloadSchemas['join_system'];
export type InputPayload = PayloadSchemas['input'];
