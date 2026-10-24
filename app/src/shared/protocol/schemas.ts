import { z } from 'zod';

/**
 * Helper to ensure numbers are finite
 */
const finiteNum = z.number().finite();

export const EntityStateSchema = z.object({
  id: z.string(),
  kind: z.enum(['ship', 'character', 'ai-ship', 'wreck']),
  pos: z.object({ x: finiteNum, y: finiteNum, z: finiteNum }),
  vel: z.object({ x: finiteNum, y: finiteNum, z: finiteNum }),
  regime: z.enum(['orbit', 'cruise', 'warp', 'docked']),
  hull: finiteNum,
  shields: finiteNum,
  targetId: z.string().nullable(),
  classId: z.string(),
  callsign: z.string().optional(),
  livery: z.string().optional(),
});

export const HelloSchema = z.object({
  v: z.number().int(),
});

export const VersionOkSchema = z.object({
  v: z.number().int(),
});

export const AuthSchema = z.object({
  token: z.string().optional(),
  callsign: z.string().optional(),
});

export const JoinSystemSchema = z.object({
  systemId: z.string(),
});

export const EnterSystemSchema = z.object({
  snapshot: z.object({
    systemId: z.string(),
    entities: z.array(EntityStateSchema),
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        pos: z.object({ x: finiteNum, y: finiteNum, z: finiteNum }),
      }),
    ),
    chat: z
      .array(
        z.object({
          sender: z.string(),
          text: z.string(),
          timestamp: z.number(),
        }),
      )
      .max(100),
    players: z.array(
      z.object({
        id: z.string(),
        callsign: z.string(),
        systemId: z.string(),
      }),
    ),
  }),
});

export const EntityUpdateSchema = z.object({
  entities: z.array(EntityStateSchema),
});

export const ChatSchema = z.object({
  text: z.string().min(1).max(500),
  channel: z.enum(['system', 'local', 'fleet']),
});

export const InputSchema = z.object({
  seq: z.number().int(),
  thrust: finiteNum,
  turn: finiteNum,
  pitch: finiteNum,
  yaw: finiteNum,
  fire: z.boolean(),
  lock: z.boolean(),
  action: z.string().optional(),
});

export const WarpSchema = z.object({
  destinationSystemId: z.string(),
});

export const InteractSchema = z.object({
  targetId: z.string(),
  action: z.string(),
});

export const MineSchema = z.object({
  targetId: z.string(),
});

export const SellSchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().positive(),
});

export const BuyShipSchema = z.object({
  classId: z.string(),
});

export const SetLiverySchema = z.object({
  color: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/),
});

export const ExitShipSchema = z.object({
  shipId: z.string(),
});

export const EnterShipSchema = z.object({
  shipId: z.string(),
});

export const RepairSchema = z.object({
  shipId: z.string(),
});

export const ErrorSchema = z.object({
  code: z.enum([
    'version-mismatch',
    'unauthenticated',
    'system-full',
    'system-not-found',
    'rate-limited',
    'invalid-message',
    'unknown-type',
  ]),
  message: z.string(),
});

export const PingSchema = z.object({
  ts: z.number(),
});

export const PongSchema = z.object({
  ts: z.number(),
});

export const PresenceSchema = z.object({
  players: z.array(
    z.object({
      id: z.string(),
      callsign: z.string(),
      online: z.boolean(),
    }),
  ),
});

export const TargetUpdateSchema = z.object({
  targetId: z.string().nullable(),
});

export const CombatEventSchema = z.object({
  kind: z.enum(['hit', 'kill']),
  attacker: z.string(),
  target: z.string(),
  weapon: z.string(),
  damage: finiteNum,
});

export const MessageSchemas: Record<string, z.ZodSchema> = {
  hello: HelloSchema,
  'version-ok': VersionOkSchema,
  auth: AuthSchema,
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
  error: ErrorSchema,
  ping: PingSchema,
  pong: PongSchema,
  presence: PresenceSchema,
  target_update: TargetUpdateSchema,
  combat_event: CombatEventSchema,
};
