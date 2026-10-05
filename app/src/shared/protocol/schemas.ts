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
  /** TASK-43: a missile in flight (a visible tracer for every client). */
  'projectile',
  /** TASK-48: a hostile surface drone (the PvE threat on foot). */
  'drone',
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
export const COMBAT_EVENT_KINDS = [
  'hit',
  'destroyed',
  'kill',
  // TASK-43: fire FX (client effects are driven from these, NEVER from the
  // local fire intent — a denied fire produces no event and no FX).
  'laser-fired',
  'missile-fired',
  'missile-impact',
] as const;
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

/**
 * One shape for all snapshot traffic (spec technical note).
 *
 * TASK-18 (wire compression, 16-player load gate): the p95 entity_update
 * at the v1 cap was ~26 KB vs the 16 KB acceptance bound. The 10 Hz frame
 * carried unchanged, often-zeroed boilerplate for ~60 entities per system,
 * so the STATIC defaults below are omitted on the wire and re-applied by
 * consumers through `normalizeEntityState`:
 * - `vel`        omitted when the entity is at rest        → {0,0,0}
 * - `rot`        omitted when the quaternion is identity   → {0,0,0,1}
 * - `regime` /   omitted for kinds that are never docked   → 'sublight' /
 *   `flightRegime`    or airborne (ships/characters only)  (no authority)
 * - `hull`       omitted at full hull                      → 1
 * - `shields`    omitted at full shields                   → 1
 * - `targetId`   omitted when nothing is targeted          → null
 * - `inventory`  omitted when empty                        → (absent)
 * Floats are rounded to 3 decimals (≤ 1 mm / rad — invisible at sim
 * scale, and the client reconciles against the authoritative frame anyway).
 * Every field is still sent whenever its value deviates from the default,
 * so the frame stays a FULL state (no delta encoding).
 */
export const entityStateSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(ENTITY_KINDS),
    pos: vec3Schema,
    vel: vec3Schema.optional(),
    /**
     * Orientation (TASK-14): client reconciliation (angle diff) and remote
     * slerp need it. Omitted when identity (TASK-18); consumers default to
     * identity.
     */
    rot: quatSchema.optional(),
    regime: z.enum(REGIMES).optional(),
    /**
     * TASK-25: the regime manager's flight regime (authoritative; the
     * client's local regimeFor is prediction only and snaps to this after
     * 500 ms of divergence). Sent only for player entities (ship /
     * character) — the ones whose owner's regime tracker reads it (TASK-18).
     */
    flightRegime: z.enum(FLIGHT_REGIMES).optional(),
    /**
     * TASK-29: set (with regime 'docked') when the ship is docked on a
     * landing pad — the pad's id. Optional for back-compat with v1 producers.
     */
    padId: z.string().min(1).optional(),
    hull: finite.min(0).max(1).optional(),
    shields: finite.min(0).max(1).optional(),
    targetId: z.string().min(1).nullable().optional(),
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
     * TASK-43: the ship's energy (ABSOLUTE 0..100), set on player-owned
     * ship entities — the weapon HUD's energy bar reads it from the SELF
     * entity_update (10 Hz). Other kinds omit it.
     */
    energy: finite.min(0).max(100).optional(),
    /**
     * TASK-45: true for kind 'ai-ship' — the rogue AI roster ships. Their
     * callsigns look like player callsigns (pirate list, 3-16 chars); the
     * client marks them 'AI' in the presence list from THIS flag (the
     * presence ENTRY list stays player-only — rogues ride the entity list).
     * Other kinds omit it.
     */
    ai: z.literal(true).optional(),
    /**
     * TASK-44: the player ids whose TARGET LOCK currently points at this
     * ship (the lock icon above the targeted ship — PvP readability
     * without a radar). Omitted when nobody is locking it; rides the
     * 10 Hz snapshot, so a released lock clears within one frame.
     */
    targetedBy: z.array(z.string().min(1)).max(64).optional(),
    /**
     * TASK-34: the owner's inventory, set on player-owned entities (ship +
     * character) — {stacks: {resourceId: amount}, weightUsed}. The client
     * renders the weight bar from its OWN entity within one snapshot.
     * Omitted while empty (TASK-18): no stacks and zero weight.
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

/** The LOOSE wire form (TASK-18): the compressible fields may be absent. */
export type WireEntityState = z.infer<typeof entityStateSchema>;

/**
 * The normalized entity view every CONSUMER works with: the wire defaults
 * re-applied (see the entityStateSchema doc). The client applies them once
 * per batch at the ingest boundary; producers (the shard's snapshot) emit
 * the wire form. Tests asserting on raw wire frames should normalize first
 * or use the `?? <default>` form.
 */
export type EntityState = WireEntityState & {
  vel: Vec3;
  regime: Regime;
  targetId: string | null;
  hull: number;
  shields: number;
};

const ZERO_VEL: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * TASK-18: apply the wire-compression defaults (see entityStateSchema) —
 * the ONE place consumers turn a loose wire entity into the full shape.
 * `rot` stays optional (its identity default was the pre-existing contract;
 * consumers apply it where they need it).
 */
export function normalizeEntityState(e: WireEntityState): EntityState {
  return {
    ...e,
    vel: e.vel ?? ZERO_VEL,
    regime: e.regime ?? 'sublight',
    targetId: e.targetId ?? null,
    hull: e.hull ?? 1,
    shields: e.shields ?? 1,
  };
}

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

/** Who landed a hit: player, AI or drone (HUD attribution, TASK-23/48). */
export const damageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('ai'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('drone'), id: z.string().min(1) }).strict(),
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
  /**
   * TASK-48: server → ONE player — the per-player hazard frame (the exposure
   * pool is private per-player state, like 'mining' — the shared
   * entity_update buffer must stay byte-identical for every peer). Sent at
   * snapshot cadence while the player is on foot. `exposure` is the personal
   * shield pool 0..50, `inside` the hazard kind the player stands in (the
   * HUD's radiation meter shows while accumulating), `recoveringUntil` the
   * epoch-ms end of the 5 s 'SHIELD BURN' knock-down (omitted when clear).
   * Server-originated only — clients never send it.
   */
  hazard: z
    .object({
      exposure: finite.min(0).max(50),
      inside: z.enum(['storm', 'radzone']).optional(),
      recoveringUntil: z.number().int().nonnegative().optional(),
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
    // TASK-43: FX events (broadcast to the WHOLE shard on every ACCEPTED
    // fire / impact — a denied fire produces no event at all, which is
    // exactly the "no FX on a denied fire" contract).
    z
      .object({
        kind: z.literal('laser-fired'),
        source: damageSourceSchema,
        weapon: z.string().min(1).max(32),
        /** The ray's endpoints (world units): nose → first hit/occlusion/max range. */
        from: vec3Schema,
        to: vec3Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('missile-fired'),
        source: damageSourceSchema,
        weapon: z.string().min(1).max(32),
        /** The spawned projectile entity id (the tracer's identity). */
        projectile: z.string().min(1),
        from: vec3Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('missile-impact'),
        weapon: z.string().min(1).max(32),
        projectile: z.string().min(1),
        /** The impact point (world units) — the splash FX + screen shake. */
        point: vec3Schema,
      })
      .strict(),
    // TASK-46: the AI BEGAN acquiring a target — the player whose ship is
    // `target` gets the 'ACQUIRING' HUD toast (the 1 s acquire delay is the
    // grace period: gameplay, not a cheat).
    z
      .object({
        kind: z.literal('ai-acquiring'),
        source: damageSourceSchema,
        /** The player ship entity id being acquired. */
        target: z.string().min(1),
      })
      .strict(),
  ]),
  /**
   * TASK-43: the ONLY inbound combat traffic — a fire INTENT. The server
   * re-derives everything (loadout, rate, energy, range, LOS, target
   * validity); a client never claims a hit (TASK-67). `targetId` is the
   * client's aim assist (nearest ship it can see); the server re-validates
   * it and a missing/invalid target is simply a denied (FX-less) fire.
   */
  fire: z
    .object({
      weapon: z.enum(['laser', 'missile']),
      targetId: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * TASK-44: target lock requests (inbound, system-scoped). The SERVER owns
   * the lock state; the client only names a target. Invalid targets answer
   * {code:'invalid-target'} (out of range / not a ship / destroyed / gone).
   * Releasing is explicit — the T-key toggle on the client sends
   * 'target_release' while a lock is held. A {code:'no-target'} error
   * answers a missile fire the server could not resolve (lock or nose cone).
   */
  target_lock: z.object({ targetId: z.string().min(1) }).strict(),
  target_release: z.object({}).strict(),
} as const;

export type MessageType = keyof typeof messageSchemas;

/** Parsed payload types, keyed by message type. */
export type PayloadSchemas = { [K in MessageType]: z.infer<(typeof messageSchemas)[K]> };

export type HelloPayload = PayloadSchemas['hello'];
export type AuthPayload = PayloadSchemas['auth'];
export type JoinSystemPayload = PayloadSchemas['join_system'];
export type InputPayload = PayloadSchemas['input'];
