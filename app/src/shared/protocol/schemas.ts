import { z } from 'zod';
import { CHAT_MAX_CHARS } from '@shared/chat';

/**
 * Shared payload schemas for the client↔server WebSocket protocol (TASK-9).
 * One zod schema per message type; imported by both client and server so the
 * wire contract has a single source of truth (names are stable — TASK-69 docs).
 */

/**
 * 'deposit' (TASK-33/37): a resource deposit — interactable on foot (pickup,
 * TASK-38's channel), carried as an entity so both the prompt raycast and the
 * 10 Hz snapshot see it. 'terminal' (TASK-33/40/53): a dock terminal —
 * interacting sends the player a 'ui-open' frame. Wire-contract additions
 * (TASK-33), noted for TASK-69.
 */
export const ENTITY_KINDS = [
  'ship',
  'character',
  'ai-ship',
  'wreck',
  'deposit',
  'terminal',
  'groundItem',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const REGIMES = ['sublight', 'cruise', 'warp', 'docked'] as const;
export type Regime = (typeof REGIMES)[number];

/**
 * TASK-25: flight regimes on the wire (the regime manager's state, shared
 * space/atmosphere/surface union). Distinct from `regime` above (wire travel
 * state); the server sends it authoritative in every entity_update.
 */
export const FLIGHT_REGIMES = ['space', 'atmosphere', 'surface'] as const;
export type FlightRegime = (typeof FLIGHT_REGIMES)[number];

/**
 * Combat event kinds (TASK-42 extends the TASK-23 contract: the sim
 * broadcasts 'hit' per landed hit, 'destroyed' on the killing hit, and
 * 'kill' when a PLAYER destroyed a player — HUD attribution, toasts, and
 * the wreck skull marker (TASK-49) read these. Wire contract change
 * noted for TASK-69).
 */
export const COMBAT_EVENT_KINDS = ['hit', 'destroyed', 'kill'] as const;
export type CombatEventKind = (typeof COMBAT_EVENT_KINDS)[number];

export const PRESENCE_EVENTS = ['join', 'leave'] as const;
export type PresenceEvent = (typeof PRESENCE_EVENTS)[number];

/** Finite numbers only — NaN/Infinity never cross the wire. */
const finite = z.number().finite();

export const vec3Schema = z.object({ x: finite, y: finite, z: finite }).strict();
export type Vec3 = z.infer<typeof vec3Schema>;

/** Unit quaternion {x, y, z, w} (Hamilton, scalar last — matches shared/physics/vec). */
export const quatSchema = z.object({ x: finite, y: finite, z: finite, w: finite }).strict();
export type Quat = z.infer<typeof quatSchema>;

export const liverySchema = z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/));
export type Livery = z.infer<typeof liverySchema>;

/** One shape for all snapshot traffic (spec technical note). */
export const entityStateSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(ENTITY_KINDS),
    pos: vec3Schema,
    vel: vec3Schema,
    /**
     * Orientation (TASK-14): client reconciliation (angle diff) and remote
     * slerp need it. Optional on the wire for back-compat with v1 producers
     * (the shard in this repo always sends it); consumers default to identity.
     */
    rot: quatSchema.optional(),
    regime: z.enum(REGIMES),
    /**
     * TASK-25: the regime manager's flight regime (authoritative; the
     * client's local regimeFor is prediction only and snaps to this after
     * 500 ms of divergence). Optional for back-compat with v1 producers.
     */
    flightRegime: z.enum(FLIGHT_REGIMES).optional(),
    /**
     * TASK-29: set (with regime 'docked') when the ship is docked on a
     * landing pad — the pad's id. Optional for back-compat with v1 producers.
     */
    padId: z.string().min(1).optional(),
    hull: finite.min(0).max(1),
    shields: finite.min(0).max(1),
    targetId: z.string().min(1).nullable(),
    classId: z.string().min(1),
    callsign: z.string().min(1).max(24).optional(),
    livery: liverySchema.optional(),
    /**
     * TASK-31: set for kind 'character' — the on-foot player entity spawned
     * on disembark. Identifies its owner (the sim keeps one character per
     * disembarked player). Ships omit it.
     */
    playerId: z.string().min(1).optional(),
    /**
     * TASK-31: true for kind 'character' (an on-foot player). The client
     * routes its control target + camera off this flag.
     */
    onFoot: z.boolean().optional(),
    /**
     * TASK-33: remaining units, for kind 'deposit' only. Wire-visible so a
     * pickup shows as a quantity change — or a removal at zero — in the
     * next 10 Hz snapshot for every client. Other kinds omit it.
     */
    quantity: z.number().int().finite().nonnegative().optional(),
    /**
     * TASK-34: the resource a kind 'groundItem' entity holds (dropped
     * inventory, 300 s ttl). `quantity` is its unit count. Other kinds omit
     * it. Wire contract addition (TASK-69 docs).
     */
    resourceId: z.string().min(1).optional(),
    /**
     * TASK-42: the killing source's id, set on kind 'wreck' — the skull
     * marker TASK-49 renders until the wreck despawns. Other kinds omit it.
     */
    killerId: z.string().min(1).optional(),
    /**
     * TASK-34: the owner's inventory, set on player-owned entities (ship +
     * character) — {stacks: {resourceId: amount}, weightUsed}. The client
     * renders the weight bar from its OWN entity within one snapshot.
     */
    inventory: z
      .object({
        stacks: z.record(z.string().min(1), z.number().int().finite().nonnegative()),
        weightUsed: z.number().int().finite().nonnegative(),
      })
      .strict()
      .optional(),
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

/**
 * System chat contract (TASK-16):
 * - inbound  'chat' {text}: 1..200 chars AFTER trim — enforced here so
 *   empty / overlong / non-string payloads all fail parseMessage with
 *   invalid-message;
 * - outbound 'chat' {from, text, ts}: server-assigned ms-epoch ts (strictly
 *   monotonic per shard, so every client orders identically), broadcast to
 *   the WHOLE shard including the sender.
 * The registry entry is a union: the client's parseMessage must accept the
 * server's broadcast shape; only the inbound form is ever dispatched.
 */
export const chatInboundSchema = z
  .object({ text: z.string() })
  .strict()
  .refine(
    (p) => {
      const trimmed = p.text.trim();
      return trimmed.length >= 1 && trimmed.length <= CHAT_MAX_CHARS;
    },
    { message: `text must be 1..${CHAT_MAX_CHARS} characters after trim` },
  );
export type ChatInbound = z.infer<typeof chatInboundSchema>;

export const chatMessageSchema = z
  .object({
    from: z.string().min(1).max(24),
    text: z.string().min(1).max(CHAT_MAX_CHARS),
    /** Server-assigned ms epoch; strictly increasing within a shard. */
    ts: z.number().int().nonnegative(),
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

/** Who landed a hit: player or AI (HUD attribution, TASK-23). */
export const damageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('ai'), id: z.string().min(1) }).strict(),
]);
export type DamageSource = z.infer<typeof damageSourceSchema>;

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
  /** TASK-66: revokes the connection's auth token, then the server closes 1000. */
  logout: z.object({}).strict(),
  enter_system: z.object({ snapshot: stateSnapshotSchema }).strict(),
  state_snapshot: stateSnapshotSchema,
  entity_update: z.object({ entities: z.array(entityStateSchema).min(1).max(1000) }).strict(),
  chat: z.union([chatInboundSchema, chatMessageSchema]),
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
  /**
   * TASK-8: server → client, sent when the warp is server-side complete.
   * The client swaps its world to the target system (star/planets/spawn
   * gate) and plays the warp-out. Same snapshot shape as enter_system; the
   * separate type tells the client this is a TRANSITION, not a (re)join.
   */
  warp_arrived: z
    .object({ systemId: z.string().min(1).max(64), snapshot: stateSnapshotSchema })
    .strict(),
  /**
   * TASK-33: on-foot interaction — the target id only; the SERVER dispatches
   * by the target's kind (deposit / ship / terminal / groundItem). `action`
   * is optional and kind-specific: TASK-38's deposit flow is the hold-to-
   * mine channel — 'mine-start' (E down) begins it, 'mine-tick' re-asserts
   * intent, 'mine-stop' (E up) cancels it; the server's tick is the award
   * authority (a legacy 'pickup' on a deposit still starts the channel).
   */
  interact: z
    .object({ targetId: z.string().min(1), action: z.string().min(1).max(32).optional() })
    .strict(),
  /**
   * TASK-38: server → ONE player — the authoritative mining-channel state.
   * Sent at 10 Hz (snapshot cadence) while that player is channeling, plus
   * one final phase:'ended' frame when the channel dies. Per-connection on
   * purpose: the shared entity_update buffer must stay byte-identical for
   * every in-system peer (the encode-once design — the TASK-14 'ack'
   * precedent), and the channel is the miner's private view.
   */
  mining: z.discriminatedUnion('phase', [
    z
      .object({
        phase: z.literal('active'),
        depositId: z.string().min(1),
        /** Progress 0..1 through the current 1.5 s unit (server clock echo). */
        progress: finite.min(0).max(1),
        /** Units already awarded in this channel (the client's ore counter). */
        units: z.number().int().finite().nonnegative(),
        /** 'full': at the weight cap — the channel is PAUSED ('Backpack full'). */
        status: z.enum(['mining', 'full']),
      })
      .strict(),
    z
      .object({
        phase: z.literal('ended'),
        depositId: z.string().min(1),
        /** stopped: E released; cancelled: out of range / character gone; depleted: the deposit ran out. */
        reason: z.enum(['stopped', 'cancelled', 'depleted']),
        /** Units awarded in total (no unit is awarded on cancel). */
        units: z.number().int().finite().nonnegative(),
      })
      .strict(),
  ]),
  mine: z.object({ nodeId: z.string().min(1) }).strict(),
  /**
   * TASK-40: the dock sell — client → server `{resourceId, amount, source}`
   * (the WS alias of POST /api/ships/sell, same handler; source 'hold' =
   * the ship's cargo hold (docked required), 'inv' = the on-foot inventory
   * (on foot, within 10 m of a station terminal)). Server → client result
   * `{resourceId, sold, earned, balance, hold, inventory}` — the new
   * stacks ride the frame so the dock panel re-renders (source stack
   * decreases) and the credits counter updates within one frame, plus the
   * '+N cr' float. Replaces the unused v0 placeholder {cargoId, quantity}.
   * Wire contract change documented for TASK-69.
   */
  sell: z.union([
    z
      .object({
        resourceId: z.string().min(1).max(32),
        amount: z.number().int().finite().positive(),
        source: z.enum(['hold', 'inv']),
      })
      .strict(),
    z
      .object({
        resourceId: z.string().min(1).max(32),
        sold: z.number().int().finite().nonnegative(),
        earned: z.number().int().finite().nonnegative(),
        balance: z.number().int().finite().nonnegative(),
        hold: z
          .object({
            stacks: z.record(z.string().min(1), z.number().int().finite().nonnegative()),
            weightUsed: z.number().int().finite().nonnegative(),
            capacity: z.number().int().finite().nonnegative(),
          })
          .strict(),
        inventory: z
          .object({
            stacks: z.record(z.string().min(1), z.number().int().finite().nonnegative()),
            weightUsed: z.number().int().finite().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  ]),
  buy_ship: z.object({ classId: z.string().min(1).max(32) }).strict(),
  set_livery: z.object({ livery: liverySchema }).strict(),
  /**
   * TASK-34: drop `amount` units of `resourceId` from the player's inventory
   * at their position — the server spawns a 'groundItem' entity (300 s ttl,
   * visible to all players, re-takeable via the interact 'pickup').
   */
  drop: z
    .object({
      resourceId: z.string().min(1).max(32),
      amount: z.number().int().finite().positive(),
    })
    .strict(),
  exit_ship: z.object({ shipId: z.string().min(1) }).strict(),
  enter_ship: z.object({ shipId: z.string().min(1) }).strict(),
  repair: z.object({}).strict(),
  /**
   * TASK-39: move `amount` units of `resourceId` between the on-foot
   * inventory and the ship's cargo hold. `from: 'inv'` = LOAD (into the
   * hold), `from: 'hold'` = UNLOAD (back to the inventory). The server
   * (docked + on foot + within 5 m of the own ship) moves what FITS
   * (partial at the boundary — the hold nears its cap, or the destination
   * runs out of weight room) and answers with a 'cargo' frame. The ship is
   * implicit (the player's own — one ship per player, v1 invariant).
   */
  cargo_transfer: z
    .object({
      resourceId: z.string().min(1).max(32),
      amount: z.number().int().finite().positive(),
      from: z.enum(['inv', 'hold']),
    })
    .strict(),
  /**
   * TASK-39: open the cargo panel. Sent by the ship-HUD 'Cargo' button (in
   * flight / docked) — the server answers with a 'cargo' frame of the OWN
   * hold (no inventory side: transfers require being on foot at the ship).
   * The on-foot 'Open cargo' prompt instead uses 'interact' {action:
   * 'open-cargo'} so the shared interact validation (target + range) applies.
   */
  cargo_open: z.object({}).strict(),
  /**
   * TASK-39: server → ONE player — the cargo panel's contents (the hold
   * always; the inventory only when sent from the on-foot prompt). The
   * panel re-renders from this frame after every 'cargo_transfer'.
   * Server-originated only — clients never send it.
   */
  cargo: z
    .object({
      hold: z
        .object({
          stacks: z.record(z.string().min(1), z.number().int().finite().nonnegative()),
          weightUsed: z.number().int().finite().nonnegative(),
          capacity: z.number().int().finite().nonnegative(),
        })
        .strict(),
      inventory: z
        .object({
          stacks: z.record(z.string().min(1), z.number().int().finite().nonnegative()),
          weightUsed: z.number().int().finite().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /**
   * TASK-14: the server tells a connection the last input seq it has APPLIED
   * (integrated in a tick). Server→client only, sent to the owning
   * connection at snapshot cadence so the 10 Hz shared snapshot buffer stays
   * identical for every in-system peer (per-entity acks would break the
   * encode-once design). Wire contract change documented for TASK-69.
   */
  ack: z.object({ seq: z.number().int().finite().nonnegative() }).strict(),
  /**
   * TASK-33: server → ONE client — the server wants a UI panel open (the
   * dock-terminal interaction). `ui` names the panel ('dock' in v1) and
   * `payload` is its seed data (the dock UI, TASK-40/53, consumes it); the
   * shape stays generic for future terminal kinds. Server-originated only —
   * clients never send it.
   */
  'ui-open': z
    .object({
      ui: z.string().min(1).max(32),
      payload: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
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
  /**
   * TASK-42: the sim broadcasts combat_event to the WHOLE shard when a
   * weapon hit lands (the server-side resolveHit pipeline). 'hit' per
   * landed hit (damage/shieldHit/hullHit in points, shield-first; `weapon`
   * is the firing WeaponSpec id — the HUD reads "interceptor laser hit
   * your hull for 8" from these fields); the killing hit broadcasts
   * 'destroyed' INSTEAD of a 'hit' (no damage fields — the target is gone);
   * 'kill' ADDITIONALLY when the source is a PLAYER (killer = source id,
   * victim = the ship entity id). Source mirrors the domain DamageSource in
   * @shared/physics/damage (HUD attribution).
   */
  combat_event: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('hit'),
        target: z.string().min(1),
        source: damageSourceSchema,
        weapon: z.string().min(1).max(32),
        damage: finite.min(0),
        shieldHit: finite.min(0),
        hullHit: finite.min(0),
      })
      .strict(),
    z
      .object({
        kind: z.literal('destroyed'),
        target: z.string().min(1),
        source: damageSourceSchema,
        weapon: z.string().min(1).max(32),
      })
      .strict(),
    z
      .object({
        kind: z.literal('kill'),
        killer: z.string().min(1),
        victim: z.string().min(1),
        weapon: z.string().min(1).max(32),
      })
      .strict(),
  ]),
} as const;

export type MessageType = keyof typeof messageSchemas;

/** Parsed payload types, keyed by message type. */
export type PayloadSchemas = { [K in MessageType]: z.infer<(typeof messageSchemas)[K]> };

export type HelloPayload = PayloadSchemas['hello'];
export type AuthPayload = PayloadSchemas['auth'];
export type JoinSystemPayload = PayloadSchemas['join_system'];
export type InputPayload = PayloadSchemas['input'];
