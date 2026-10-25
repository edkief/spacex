import { z } from 'zod';

/**
 * Helper to ensure numbers are finite
 */
const finiteNum = z.number().finite();

export const EntityStateSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['ship', 'character', 'ai-ship', 'wreck']),
    pos: z.object({ x: finiteNum, y: finiteNum, z: finiteNum }).strict(),
    vel: z.object({ x: finiteNum, y: finiteNum, z: finiteNum }).strict(),
    quat: z.object({ x: finiteNum, y: finiteNum, z: finiteNum, w: finiteNum }).strict(),
    regime: z.enum(['space', 'atmosphere', 'surface']),
    hull: finiteNum,
    shields: finiteNum,
    targetId: z.string().nullable(),
    classId: z.string(),
    callsign: z.string().optional(),
    livery: z.string().optional(),
    lastAppliedSeq: z.number().int().optional(),
  })
  .strict();

export type EntityState = z.infer<typeof EntityStateSchema>;

export const HelloSchema = z
  .object({
    v: z.number().int(),
  })
  .strict();

export const VersionOkSchema = z
  .object({
    v: z.number().int(),
  })
  .strict();

export const AuthSchema = z
  .object({
    token: z.string().optional(),
    callsign: z.string().optional(),
  })
  .strict();

export const AuthOkSchema = z
  .object({
    playerId: z.string(),
  })
  .strict();

export const JoinSystemSchema = z
  .object({
    systemId: z.string(),
  })
  .strict();

export const EnterSystemSchema = z
  .object({
    snapshot: z
      .object({
        systemId: z.string(),
        entities: z.array(EntityStateSchema),
        nodes: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              pos: z.object({ x: finiteNum, y: finiteNum, z: finiteNum }).strict(),
            })
            .strict(),
        ),
        chat: z
          .array(
            z
              .object({
                sender: z.string(),
                text: z.string(),
                timestamp: z.number(),
              })
              .strict(),
          )
          .max(100),
        players: z.array(
          z
            .object({
              id: z.string(),
              callsign: z.string(),
              systemId: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export const EntityUpdateSchema = z
  .object({
    entities: z.array(EntityStateSchema),
  })
  .strict();

export const ChatSchema = z
  .object({
    text: z.string().min(1).max(1000),
    channel: z.enum(['system', 'local', 'fleet']),
  })
  .strict();

export const InputSchema = z
  .object({
    seq: z.number().int(),
    thrust: finiteNum,
    turn: finiteNum,
    pitch: finiteNum,
    yaw: finiteNum,
    fire: z.boolean(),
    lock: z.boolean(),
    action: z.string().optional(),
  })
  .strict();

export const WarpSchema = z
  .object({
    destinationSystemId: z.string(),
  })
  .strict();

export const InteractSchema = z
  .object({
    targetId: z.string(),
    action: z.string(),
  })
  .strict();

export const MineSchema = z
  .object({
    targetId: z.string(),
  })
  .strict();

export const SellSchema = z
  .object({
    itemId: z.string(),
    quantity: z.number().int().positive(),
  })
  .strict();

export const BuyShipSchema = z
  .object({
    classId: z.string(),
  })
  .strict();

export const SetLiverySchema = z
  .object({
    color: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/),
  })
  .strict();

export const ExitShipSchema = z
  .object({
    shipId: z.string(),
  })
  .strict();

export const EnterShipSchema = z
  .object({
    shipId: z.string(),
  })
  .strict();

export const RepairSchema = z
  .object({
    shipId: z.string(),
  })
  .strict();

export const LogoutSchema = z.object({}).strict();

export const ErrorSchema = z
  .object({
    code: z.enum([
      'version-mismatch',
      'unauthenticated',
      'system-full',
      'system-not-found',
      'rate-limited',
      'invalid-message',
      'unknown-type',
      'callsign-taken',
    ]),
    message: z.string(),
  })
  .strict();

export const CallsignClaimSchema = z
  .object({
    callsign: z
      .string()
      .min(3)
      .max(16)
      .regex(/^[a-zA-Z0-9-]+$/),
  })
  .strict();

export const PingSchema = z
  .object({
    ts: z.number(),
  })
  .strict();

export const PongSchema = z
  .object({
    ts: z.number(),
  })
  .strict();

export const PresenceSchema = z
  .object({
    players: z.array(
      z
        .object({
          id: z.string(),
          callsign: z.string(),
          online: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const TargetUpdateSchema = z
  .object({
    targetId: z.string().nullable(),
  })
  .strict();

export const CombatEventSchema = z
  .object({
    kind: z.enum(['hit', 'kill']),
    attacker: z.string(),
    target: z.string(),
    weapon: z.string(),
    damage: finiteNum,
  })
  .strict();

export const MessageSchemas: Record<string, z.ZodSchema> = {
  hello: HelloSchema,
  'version-ok': VersionOkSchema,
  auth: AuthSchema,
  'auth-ok': AuthOkSchema,
  join_system: JoinSystemSchema,
  enter_system: EnterSystemSchema,
  state_snapshot: EnterSystemSchema, // Same shape as enter_system payload for convenience
  entity_update: EntityUpdateSchema,
  chat: ChatSchema,
  input: InputSchema,
  warp: WarpSchema,
  interact: InteractSchema,
  mine: MineSchema,
  sell: SellSchema,
  buy_ship: BuyShipSchema,
  set_livery: SetLiverySchema,
  exit_ship: ExitShipSchema,
  enter_ship: EnterShipSchema,
  repair: RepairSchema,
  logout: LogoutSchema,
  error: ErrorSchema,
  ping: PingSchema,
  pong: PongSchema,
  presence: PresenceSchema,
  target_update: TargetUpdateSchema,
  combat_event: CombatEventSchema,
};
