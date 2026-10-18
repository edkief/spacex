/**
 * Payload schemas for the Drift WebSocket protocol (TASK-9).
 *
 * One `z.ZodType` per message type. These schemas are imported by both the
 * server (for inbound validation) and the client (for outbound validation
 * and inbound parsing), so the wire contract lives in exactly one place.
 *
 * Conventions:
 *   - Every numeric field uses `z.number().finite()` so a hostile client
 *     cannot send `NaN` or `±Infinity` through the parse boundary.
 *   - Optional fields default to `undefined` (i.e. `.optional()`), never
 *     `null`. Nullable fields use `.nullable()` explicitly with a reason.
 *   - IDs are non-empty strings; we don't try to enforce UUID format
 *     because the persistence layer (TASK-62) is the source of truth.
 *   - Object shapes use `.strict()` on envelopes and on the EntityState
 *     sub-shape to surface typos early; permissive shapes use the default.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable sub-schemas
// ---------------------------------------------------------------------------

/**
 * Three-element position/velocity tuple (light-seconds, or metres on a
 * surface chunk). Tuples are intentionally compact on the wire: the
 * receiving code already knows it is reading a vector.
 */
export const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/** Ship class id (matches `SHIP_CLASS_IDS` in `src/server/db/types.ts`). */
export const ShipClassIdSchema = z.enum(["scout", "freighter", "interceptor"]);
export type ProtocolShipClassId = z.infer<typeof ShipClassIdSchema>;

/** Entity kind tag (one shape for snapshot, entity_update, presence). */
/**
 * The kinds of entity the wire recognises (TASK-33 added
 * `deposit` + `terminal` for proximity interaction). Ship /
 * character / ai-ship / wreck predate this. The server-side
 * `EntityKind` (in `@server/shard/types`) is a separate union
 * that includes the unrendered `player` (maps to `ship` here).
 */
export const EntityKindSchema = z.enum([
  "ship",
  "character",
  "ai-ship",
  "wreck",
  "deposit",
  "terminal",
  "groundItem",
]);
export type ProtocolEntityKind = z.infer<typeof EntityKindSchema>;

/** Regime tag — drives the rendering pipeline (TASK-25). */
export const RegimeSchema = z.enum(["space", "orbit", "atmosphere", "surface"]);
export type ProtocolRegime = z.infer<typeof RegimeSchema>;

/** Player-level state machine (TASK-23 / TASK-29 / TASK-31). */
export const PlayerActivitySchema = z.enum(["docked", "flying", "onfoot"]);
export type ProtocolPlayerActivity = z.infer<typeof PlayerActivitySchema>;

/** Ship livery (matches `ShipLivery` in the persistence layer). */
export const LiverySchema = z
  .object({
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  })
  .strict();

/**
 * Entity state — the universal shape for ships, characters, AI ships and
 * wrecks on the wire. Future tasks (TASK-13/22/45) extend the *runtime*
 * meaning of each field, but the shape is stable here.
 *
 * TASK-31: `onFoot` is the discriminator for character entities. Ships,
 * AI ships, and wrecks leave it `false`/absent; characters set it
 * `true`. The field is intentionally at the top of the shape (not on a
 * sub-type) because the wire-level discriminator is `kind` and the
 * character-specific extension is a single boolean — splitting the
 * schema into a discriminated union would force every consumer to
 * handle four branches where one boolean does the job. Existing
 * clients (pre-TASK-31) ignore the extra key because `parseMessage`
 * strips unknowns at the envelope layer; old servers that emit the
 * shape without `onFoot` still validate because the field is
 * `.optional()`.
 */
export const EntityStateSchema = z
  .object({
    id: z.string().min(1),
    kind: EntityKindSchema,
    pos: Vec3Schema,
    vel: Vec3Schema,
    regime: RegimeSchema,
    hull: z.number().finite(),
    shields: z.number().finite(),
    targetId: z.string().min(1).nullable(),
    classId: ShipClassIdSchema.nullable(),
    callsign: z.string().min(1).nullable(),
    livery: LiverySchema.nullable(),
    /**
     * TASK-29: id of the landing pad the ship is currently docked
     * on. `null` when the ship is flying or undocked. Stable per
     * `(seed, planetId, chunkX, chunkZ)` — see `LandingPad.id` in
     * `@shared/galaxy/types`. Clients use the field to drive the
     * in-HUD "DOCKED" indicator (TASK-29 acceptance criterion).
     *
     * TASK-31: characters inherit the pad id from the ship they
     * disembarked from (so the "Ship is docked here" prompt can keep
     * showing until the character walks away — TASK-32 wires the
     * distance cull).
     */
    onPad: z.string().min(1).nullable(),
    /**
     * TASK-31: `true` when the entity is an on-foot character.
     * Defaults to `undefined` so the field is absent from ship /
     * AI / wreck snapshots (no bandwidth cost on the 10 Hz
     * broadcast). Consumers distinguish "kind === 'character'"
     * first; `onFoot` is a convenience flag for renderer code paths
     * that need to gate without a switch.
     */
    onFoot: z.boolean().optional(),
    /**
     * TASK-34: resource id carried by a `deposit` or `groundItem`
     * entity. Absent on ships / characters / AI / wrecks /
     * terminals. Validated by the server-side registry against the
     * inventory catalog at the interaction boundary, not by zod
     * here, because the catalog can grow without a protocol bump.
     */
    resourceType: z.string().min(1).optional(),
    /**
     * TASK-34: stack amount carried by a `deposit` or `groundItem`
     * entity. Absent on ships / characters / AI / wrecks /
     * terminals. Decreases in-place on a partial pickup (the next
     * 10 Hz snapshot carries the new value).
     */
    amount: z.number().int().positive().optional(),
  })
  .strict();
export type ProtocolEntityState = z.infer<typeof EntityStateSchema>;

/**
 * A single chat line (entry in the rolling 100-message history).
 *
 * `text` is the *sanitized* form the server sends; the server caps
 * the post-trim length at 200 characters (TASK-16) so the wire
 * shape is narrow. `id` is server-assigned and monotonic per shard
 * (the client uses it to dedupe echos when the broadcast loop
 * races with the original send).
 */
export const ChatEntrySchema = z
  .object({
    id: z.string().min(1),
    author: z.string().min(1),
    text: z.string().min(1).max(200),
    ts: z.number().int().finite(),
  })
  .strict();

/** Resource node snapshot (subset of `ResourceNode` from TASK-5). */
export const NodeSnapshotSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    quantity: z.number().int().nonnegative(),
  })
  .strict();

/** A single presence record. */
export const PresenceEntrySchema = z
  .object({
    playerId: z.string().min(1),
    callsign: z.string().min(1),
    shipId: z.string().min(1).nullable(),
    state: PlayerActivitySchema,
  })
  .strict();

/** Structured error code (TASK-9 + TASK-31 + TASK-33 acceptance criteria). */
export const ErrorCodeSchema = z.enum([
  "version-mismatch",
  "unauthenticated",
  "system-full",
  "system-not-found",
  "rate-limited",
  "invalid-message",
  "unknown-type",
  // TASK-31: disembark denied because the ship is not currently
  // docked on a landing pad. Surfaced on `exit_ship` frames; the
  // client renders a "Cannot disembark while flying" toast.
  "not-docked",
  // TASK-33: proximity interaction denied because the player is
  // farther than 3 m from the targeted entity. Surfaced on
  // `interact` frames; the prompt UI never displays invalid
  // targets (client pre-filters), so reaching this path means a
  // frame raced past the prompt update (e.g. a teleport cheat).
  "out-of-range",
  // TASK-33: proximity interaction denied because the player's
  // *active regime* doesn't match — e.g. attempting to inspect
  // a dock terminal while sitting inside a ship (the character
  // isn't on foot yet). The handler maps the shard's `isOnFoot`
  // flag onto this code.
  "wrong-regime",
  // TASK-33: proximity interaction denied because the targeted
  // entity doesn't exist in the shard's registry (id mismatch,
  // already-collected pickup, etc). Mirrors the server-side
  // convention; the registry refuses to dispatch for an unknown
  // kind, but the client may have raced ahead of the entity
  // removal broadcast.
  "not-found",
]);
export type ProtocolErrorCode = z.infer<typeof ErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Per-message-type payload schemas
// ---------------------------------------------------------------------------

/**
 * `hello` — first message in either direction.
 *   - Client → server: `{ version, client? }` announces the client's
 *     protocol version (must equal `PROTOCOL_VERSION`) and an optional
 *     client identifier string (used for analytics / debug logs).
 *   - Server → client: `{ version, serverTickHz }` is the success ack
 *     (`version_ok` semantic) carrying the authoritative tick rate that
 *     drives the client interpolation buffer (TASK-13).
 */
export const HelloSchema = z
  .object({
    version: z.number().int().nonnegative(),
    client: z.string().min(1).max(64).optional(),
    serverTickHz: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `auth` — second handshake step. The token form is the normal path once
 * the client has a session; the callsign-only form is used by the
 * first-run experience (TASK-56) and by the auth flow defined in TASK-10.
 */
export const AuthSchema = z.union([
  z.object({ token: z.string().min(1) }).strict(),
  z.object({ callsign: z.string().min(1).max(32) }).strict(),
]);

/** `auth_ok` — server-only ack for `auth`. */
export const AuthOkSchema = z
  .object({
    playerId: z.string().min(1),
    callsign: z.string().min(1),
    tokenExpiresAt: z.number().int().finite(),
  })
  .strict();

/** `join_system` — third handshake step. The client picks a system by id. */
export const JoinSystemSchema = z
  .object({
    systemId: z.string().min(1),
  })
  .strict();

/**
 * `enter_system` — server-only success response to `join_system`.
 * Carries the canonical snapshot the client should hydrate from (TASK-17
 * resync uses the same shape).
 */
export const EnterSystemSchema = z
  .object({
    systemId: z.string().min(1),
    entities: z.array(EntityStateSchema),
    nodes: z.array(NodeSnapshotSchema),
    chat: z.array(ChatEntrySchema),
    players: z.array(z.string().min(1)),
    serverTickHz: z.number().int().positive(),
    snapshotTick: z.number().int().nonnegative(),
  })
  .strict();

/** `state_snapshot` — full snapshot broadcast at 10 Hz (TASK-13). */
export const StateSnapshotSchema = z
  .object({
    systemId: z.string().min(1),
    tick: z.number().int().nonnegative(),
    entities: z.array(EntityStateSchema),
    nodes: z.array(NodeSnapshotSchema),
    chat: z.array(ChatEntrySchema),
    players: z.array(z.string().min(1)),
  })
  .strict();

/**
 * `entity_update` — delta snapshot (subset of state_snapshot).
 *
 * `lastAppliedSeq` (TASK-14): the seq of the most recent player input
 * the server has integrated into the owning player's entity, plus a
 * `seqs` map keyed by player id. The client uses the relevant entry
 * to reconcile its input queue. When the entity_update is a
 * non-player-only frame (AI ships, NPC wrecks) the map is empty and
 * the field is still emitted so clients can use a single uniform
 * parser. Optional for backward-compatibility with pre-TASK-14
 * builds that did not include the ack.
 */
export const EntityUpdateSchema = z
  .object({
    systemId: z.string().min(1),
    tick: z.number().int().nonnegative(),
    entities: z.array(EntityStateSchema),
    /** Map of playerId → last input seq the server integrated for that player. */
    lastAppliedSeq: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .strict();

/**
 * `chat` — outbound text message (TASK-16).
 *
 * The wire cap is `500` characters so a client can send an oversized
 * payload and still receive a structured `invalid-message` rejection
 * (TASK-64) — the 200-character post-trim cap is enforced
 * server-side inside the chat pipeline.
 */
export const ChatSchema = z
  .object({
    text: z.string().min(1).max(500),
  })
  .strict();

/** `input` — client → server control frame (predicted by the client). */
export const InputSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    thrust: z.number().finite(),
    turn: z.number().finite(),
    pitch: z.number().finite(),
    yaw: z.number().finite(),
    fire: z.boolean(),
    lock: z.boolean(),
    action: z.string().min(1).max(64).nullable(),
  })
  .strict();

/**
 * `warp` — inter-system travel request (TASK-8). Client → server.
 *
 * The client sends this after the chart UI's Warp button is clicked;
 * the server validates the target system, spawns it on demand via the
 * galaxy router (TASK-11), repositions the player's ship at the
 * target's spawn gate, and replies with a `warp_arrived` frame carrying
 * the canonical target-system snapshot. On rejection (target missing,
 * target full, etc.) the server replies with an `error` frame so the
 * client can render a "System full" toast and stay in the source system.
 */
export const WarpSchema = z
  .object({
    targetSystemId: z.string().min(1),
  })
  .strict();

/**
 * `warp_arrived` — server-only success response to `warp` (TASK-8).
 *
 * The shape mirrors `enter_system` exactly: the client receives the
 * canonical snapshot the player should hydrate from in their new
 * system. We define it as a distinct schema (rather than reusing
 * `EnterSystemSchema` via `z.lazy`) so a future TASK that needs to
 * extend one side (e.g. adding a `spawnGatePos` vector to the warp
 * arrival) doesn't silently change the initial-join path.
 *
 * The `targetSystemId` echoes back what the client sent so the
 * client can correlate the frame with the in-flight warp slot (the
 * warp state machine discards frames whose `targetSystemId` does not
 * match the currently-warping target).
 */
export const WarpArrivedSchema = z
  .object({
    targetSystemId: z.string().min(1),
    systemId: z.string().min(1),
    entities: z.array(EntityStateSchema),
    nodes: z.array(NodeSnapshotSchema),
    chat: z.array(ChatEntrySchema),
    players: z.array(z.string().min(1)),
    serverTickHz: z.number().int().positive(),
    snapshotTick: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `interact` — proximity interaction (TASK-33).
 *
 *   - `targetId` — the entity id the client wants to act on. The
 *     server resolves this against the active shard's registry;
 *     a missing id returns `{code:'not-found'}`.
 *   - `action` — the kind of interaction. The client picks one of
 *     these based on the prompt shown (the registry maps entity
 *     kind → {prompt, action}).
 *       - `'inspect'` — generic look-at (small flavour); not used
 *         for actual side effects.
 *       - `'use'`    — generic activation (dock terminal, pickup).
 *       - `'enter'`  — re-enter a docked ship (TASK-35 owner).
 *       - `'exit'`   — disembark from a docked ship (TASK-31
 *         handlers; TASK-33 only references it as the schema
 *         value for completeness).
 *       - `'mine'`   — long-running extraction (TASK-38 owner).
 *
 * The server validates `(targetId, action)` against the
 * `InteractableRegistry` dispatch table. The client filters
 * invalid targets before the prompt appears, so reaching the
 * dispatch path with an unknown combination is treated as a
 * protocol violation.
 */
export const InteractSchema = z
  .object({
    targetId: z.string().min(1),
    action: z.enum(["inspect", "mine", "enter", "exit", "use"]),
  })
  .strict();

/**
 * `ui_open` — server-only frame (TASK-33) commanding the client to
 * surface a named modal UI (e.g. the dock selling screen from
 * TASK-40 / TASK-53). The client owns rendering for each `ui`
 * value; the server treats it as a pure presentation directive.
 *
 * Generic by design — `payload` is forwarded verbatim into the UI
 * so future terminals (guild, missions, etc.) reuse the same
 * frame rather than spawning a new message type per terminal.
 *
 * `ui` is a small whitelisted tag, not a free string, so a
 * malformed frame can't open an arbitrary modal — `dock` is the
 * only consumer today; future tasks extend the union.
 */
export const UiOpenSchema = z
  .object({
    ui: z.enum(["dock"]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `interact_ok` — server-only ack for `interact`. Tells the owning
 * client that the interaction landed (e.g. pickup removed) so it
 * can update its local prediction / inventory without waiting for
 * the next snapshot. Other clients still learn via the regular
 * `entity_update` broadcast.
 */
export const InteractOkSchema = z
  .object({
    targetId: z.string().min(1),
    action: z.enum(["inspect", "mine", "enter", "exit", "use"]),
  })
  .strict();

/**
 * `pickup` — TASK-34. Triggered by the client's HUD as an alternative
 * to pressing `E` (e.g. a future quick-slot). Same wire semantics as
 * `interact { targetId, action: 'use' }` against a `deposit` or
 * `groundItem`; the server dedupes the two paths so a single
 * `inventory_update` ack covers both.
 */
export const PickupSchema = z
  .object({
    targetId: z.string().min(1),
  })
  .strict();

/**
 * `drop` — TASK-34. The client requests spawning a ground item
 * entity for `amount` units of `resourceType` at the player's
 * on-foot position. Server validates ownership + weight and replies
 * with an `inventory_update` ack.
 */
export const DropSchema = z
  .object({
    resourceType: z.string().min(1),
    amount: z.number().int().positive(),
  })
  .strict();

/**
 * `inventory_update` — TASK-34. Server pushed when the local
 * player's inventory changes (a pickup lands, a drop commits, or
 * the cap is reached on a partial pickup). The wire shape is the
 * canonical inventory from `@shared/world/inventory.ts` plus a
 * couple of telemetry fields (`action`, `taken`, `remaining`) the
 * client can use to render transient toast feedback without a
 * second API call.
 *
 * The snapshot broadcast already publishes `entity_update` with
 * despawned ground items — `inventory_update` is the back-channel
 * that tells the *owning* client about their own backpack so the
 * HUD doesn't have to mirror the snapshot it just sent.
 */
export const InventoryStacksSchema = z.record(z.string(), z.number().int().nonnegative());

export const InventoryUpdateSchema = z
  .object({
    stacks: InventoryStacksSchema,
    weightUsed: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
    /** What triggered this update — drives client-side toast feedback. */
    action: z.enum(["pickup-full", "pickup-partial", "drop", "set"]),
    /** Resources taken on the triggering event (0 for `set`). */
    taken: z.number().int().nonnegative(),
    /** Resources left on the source after a partial pickup (0 for full). */
    remaining: z.number().int().nonnegative(),
  })
  .strict();

/** `mine` — long-running extraction (TASK-38). */
export const MineSchema = z
  .object({
    nodeId: z.string().min(1),
    duration: z.number().finite().nonnegative(),
  })
  .strict();

/** `sell` — dock sell action (TASK-40). */
export const SellSchema = z
  .object({
    resourceType: z.string().min(1),
    quantity: z.number().int().positive(),
  })
  .strict();

/** `buy_ship` — dock purchase action (TASK-20). */
export const BuyShipSchema = z
  .object({
    classId: ShipClassIdSchema,
  })
  .strict();

/** `set_livery` — per-ship customization (TASK-21). */
export const SetLiverySchema = LiverySchema;

/** `exit_ship` — egress from ship to character (TASK-31). */
export const ExitShipSchema = z.object({}).strict();

/** `enter_ship` — re-entry from character to ship (TASK-35). */
export const EnterShipSchema = z.object({}).strict();

/** `repair` — dock repair request (TASK-23). */
export const RepairSchema = z
  .object({
    shipId: z.string().min(1).optional(),
  })
  .strict();

/**
 * `logout` — client-initiated revocation (TASK-66). The server
 * deletes the presenting player's `sessions` row and closes the WS
 * connection with code 1000 (`normal-closure`). Idempotent: a second
 * logout on the same connection is rejected with an `unauthenticated`
 * error because the session row is already gone.
 */
export const LogoutSchema = z.object({}).strict();

/**
 * `logout_ok` — server-only ack for `logout`. Carries the callsign so
 * the client can surface a "see you next time, <callsign>" toast
 * without re-querying `/api/session`.
 */
export const LogoutOkSchema = z
  .object({
    callsign: z.string().min(1),
  })
  .strict();

/** `error` — server-only structured error frame. */
export const ErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

/** `ping` — keepalive request from either side. */
export const PingSchema = z
  .object({
    t: z.number().finite(),
  })
  .strict();

/** `pong` — keepalive reply. The echo lets either side compute RTT. */
export const PongSchema = z
  .object({
    t: z.number().finite(),
  })
  .strict();

/** `presence` — broadcast of who is currently in the system (TASK-15). */
export const PresenceSchema = z
  .object({
    systemId: z.string().min(1),
    players: z.array(PresenceEntrySchema),
  })
  .strict();

/** `target_update` — current target's live stats (TASK-44). */
export const TargetUpdateSchema = z
  .object({
    targetId: z.string().min(1).nullable(),
    shields: z.number().finite().nullable(),
    hull: z.number().finite().nullable(),
    bearing: z.number().finite().nullable(),
    range: z.number().finite().nullable(),
  })
  .strict();

/**
 * `combat_event` — combat broadcast (TASK-23/42/46).
 *
 * Discriminated union of every event shape that flows through the
 * combat pipeline. The `kind` tag decides which sub-schema applies
 * so future combat events (e.g. weapon-specific damage, AI
 * broadcast fire) extend the protocol without breaking older
 * clients — old clients just see an unknown `kind` and ignore it.
 *
 *   - `hit`       (TASK-42) — a weapon impact that landed. Carries
 *                the weapon id, damage, and the tick at which it
 *                landed so the HUD can replay the impact animation.
 *   - `kill`      (TASK-42) — the kill confirmation broadcast
 *                after `hit` drives a target's hull to zero.
 *   - `damaged`   (TASK-23) — shield-first damage breakdown from
 *                `applyDamage`. `shieldHit` + `hullHit` sum to the
 *                portion of `amount` that was absorbed. `target` is
 *                the victim entity id; `source` is the attacker's
 *                attribution (player callsign / AI roster id).
 *   - `destroyed` (TASK-23) — fired exactly once per death (the
 *                sim's double-destroy guard enforces this). The
 *                renderer spawns a wreck impostor at the victim's
 *                last known position (TASK-49 owns the impostor;
 *                TASK-23 just sends the event).
 */
export const CombatEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("hit"),
      attacker: z.string().min(1),
      target: z.string().min(1),
      weapon: z.enum(["laser", "missile"]),
      damage: z.number().finite().nonnegative(),
      tick: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("kill"),
      attacker: z.string().min(1),
      target: z.string().min(1),
      tick: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("damaged"),
      target: z.string().min(1),
      source: z
        .object({
          kind: z.enum(["player", "ai"]),
          id: z.string().min(1),
        })
        .strict(),
      amount: z.number().finite().nonnegative(),
      shieldHit: z.number().finite().nonnegative(),
      hullHit: z.number().finite().nonnegative(),
      tick: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("destroyed"),
      target: z.string().min(1),
      source: z
        .object({
          kind: z.enum(["player", "ai"]),
          id: z.string().min(1),
        })
        .strict(),
      tick: z.number().int().nonnegative(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every combat event shape (TASK-23 + TASK-42/46).
 * Use this for typed `combat_event` payloads across client + server.
 */
export type ProtocolCombatEvent = z.infer<typeof CombatEventSchema>;

/**
 * TASK-34: wire shape for `inventory_update`. Mirrors the per-frame
 * JSON the server pushes when the local player's backpack changes
 * (pickup / drop / cap-reached / reset).
 */
export type ProtocolInventoryUpdate = z.infer<typeof InventoryUpdateSchema>;

// ---------------------------------------------------------------------------
// Type registry — single source of truth for `MessageType` and `parseMessage`
// ---------------------------------------------------------------------------

/**
 * Per-type payload schema registry. Imported by `@shared/protocol` which
 * re-exports the lookup helpers, `MessageType`, and `parseMessage`.
 *
 * Each key MUST be a string literal that maps to a message type the wire
 * contract recognises. Adding a new message type is a two-step change:
 *   1. Add the zod schema above.
 *   2. Add the entry below.
 * The TypeScript compiler will refuse to use a message type that is missing.
 */
export const PAYLOAD_SCHEMAS = {
  hello: HelloSchema,
  auth: AuthSchema,
  auth_ok: AuthOkSchema,
  join_system: JoinSystemSchema,
  enter_system: EnterSystemSchema,
  state_snapshot: StateSnapshotSchema,
  entity_update: EntityUpdateSchema,
  chat: ChatSchema,
  input: InputSchema,
  warp: WarpSchema,
  interact: InteractSchema,
  interact_ok: InteractOkSchema,
  ui_open: UiOpenSchema,
  pickup: PickupSchema,
  drop: DropSchema,
  inventory_update: InventoryUpdateSchema,
  mine: MineSchema,
  sell: SellSchema,
  buy_ship: BuyShipSchema,
  set_livery: SetLiverySchema,
  exit_ship: ExitShipSchema,
  enter_ship: EnterShipSchema,
  repair: RepairSchema,
  logout: LogoutSchema,
  logout_ok: LogoutOkSchema,
  error: ErrorSchema,
  ping: PingSchema,
  pong: PongSchema,
  presence: PresenceSchema,
  target_update: TargetUpdateSchema,
  combat_event: CombatEventSchema,
  warp_arrived: WarpArrivedSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

/** Discriminated union of every supported message type name. */
export type MessageType = keyof typeof PAYLOAD_SCHEMAS;

/** Companion payload type derived from a `MessageType`. */
export type PayloadFor<T extends MessageType> = z.infer<(typeof PAYLOAD_SCHEMAS)[T]>;

/** Convenience: list of every message type as an array. */
export const MESSAGE_TYPES = Object.keys(PAYLOAD_SCHEMAS) as MessageType[];
