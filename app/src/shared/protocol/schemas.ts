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
 * `deposit` + `terminal` for proximity interaction; TASK-43
 * added `missile` for the homing-projectile broadcast). Ship /
 * character / ai-ship / wreck predate this. The server-side
 * `EntityKind` (in `@server/shard/types`) is a separate union
 * that includes the unrendered `player` (maps to `ship` here)
 * and `missile` for `missile` (homing projectiles share the
 * broadcast shape but are short-lived broadcast-only entities).
 */
export const EntityKindSchema = z.enum([
  "ship",
  "character",
  "ai-ship",
  "wreck",
  "deposit",
  "terminal",
  "groundItem",
  "missile",
  // TASK-48: hostile mining drones spawned inside hazard cells.
  // The renderer draws them as small rotating octahedrons; they
  // are not targetable by `target_lock` (the cone-raycast filters
  // on `kind === 'ship'`) and they ignore ships (TASK-48 spec:
  // "drones do NOT aggro ships").
  "drone",
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
    /**
     * TASK-37: discovery flag on `deposit` entities. `true` once
     * any player has come within `DISCOVERY_RANGE_M = 50` of the
     * deposit (or picked it up). Absent on non-deposit entities.
     * Default `false`; persisted via the `deposits` table.
     */
    discovered: z.boolean().optional(),
    /**
     * TASK-44: connIds currently locking this entity. Only
     * present on `player` (and `ai`) ship entities; absent on
     * every other kind. Lets the rendered show a small lock icon
     * above a targeted ship so PvP is readable (the targeted
     * player sees who has them locked, and other players see
     * who has whom targeted).
     */
    targetedBy: z.array(z.string().min(1)).optional(),
    /**
     * TASK-45: `true` when the entity is a rogue-AI ship (a
     * pirate patrolling system space). `kind` stays `'ship'`
     * for the renderer (rogues render like player ships); the
     * `ai` flag is the only discriminator for HUD code paths
     * (e.g. an 'AI' badge in the player list, lockable in
     * TASK-44 like any other ship). Absent on player ships and
     * every other kind.
     */
    ai: z.boolean().optional(),
    /**
     * TASK-48: id of the parent hazard cell. Set on drone
     * entities so the client can resolve the drone's cell
     * (and therefore its position / radius / kind) without a
     * second lookup. Absent on every other kind.
     */
    hazardId: z.string().min(1).optional(),
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
  // TASK-35: re-entry denied because the targeted ship belongs
  // to a different player (v1 ships are single-owner). Surfaced
  // on `enter_ship` frames; the client renders a "Not your ship"
  // toast. v1 does not support boarding other ships — a
  // deliberate scope cut.
  "not-owner",
  // TASK-35: re-entry denied because the targeted ship is
  // moving (> 1 u/s). The spec calls out: a drifting ship can
  // be re-claimed; a moving ship cannot.
  "ship-moving",
  // TASK-35: re-entry is idempotent. A second `enter_ship` frame
  // that arrives while the player is already in a ship surfaces
  // this code so the client can distinguish "double-press" from
  // a real rejection.
  "already-in-ship",
  // TASK-40: dock sell denied because the player is not at a
  // station. Either the bound entity isn't a ship / isn't on a
  // pad, or the character is > 10 m from a docked ship's
  // terminal. Surfaces on `sell` frames.
  "not-at-station",
  // TASK-40: dock sell denied because the source stack is
  // smaller than the requested amount. The client UI surfaces
  // a "Cannot sell X; only Y in hold" toast.
  "insufficient",
  // TASK-43: player tried to fire a weapon but the ship has
  // less energy than the weapon's cost. The wire shape carries
  // no `amount`; the HUD reads the live `energy` field off the
  // owning ship entity and surfaces a "LOW ENERGY" prompt.
  "low-energy",
  // TASK-43: anti-spam lockout. A connection firing more than
  // 30 weapons per second is locked out for 5 s. The server
  // queues no shots during the lockout and every shot attempt
  // surfaces this code until the timer expires.
  "weapon-locked",
  // TASK-43: the chosen weapon is not equipped on this ship's
  // loadout (e.g. a scout firing missiles). Surfaced on `fire`
  // frames so the HUD can render a "weapon not equipped" toast.
  "weapon-not-equipped",
  // TASK-43: fire intent without a target (the resolver rejects
  // with `unknown-target`). Distinct from `not-found` so the HUD
  // can render a "no target locked" prompt rather than "missing
  // entity" — the typical case is the lock-on target evaporated
  // between fire-decision and fire-arrival.
  "no-target",
  // TASK-44: target_lock request rejected because the requested
  // entity is out of lock range (> 500 m), outside the 30° nose
  // cone, not a ship (a deposit / station / terminal / ground
  // item is not lockable in v1), or already destroyed. The client
  // renders a "NO TARGET" prompt so a denied missile fire doesn't
  // silently consume ammo.
  "invalid-target",
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
 * `fire` — TASK-43 weapon-fire intent (client → server).
 *
 * Distinct from the `input.fire` boolean because the v1 weapon
 * system is rich enough to warrant its own frame:
 *
 *   - `weapon`  — which weapon the player is firing. The server
 *                 resolves per-loadout availability (a scout firing
 *                 `missile` surfaces `weapon-not-equipped`).
 *   - `targetId` — optional locked target id. Missiles home on
 *                 this target; lasers resolve to the first entity
 *                 inside `range` (no leading required, so the
 *                 `targetId` is purely advisory on the laser path).
 *                 Absent / `null` means "no lock" — both weapons
 *                 are legal but the missile can't home and the
 *                 laser resolves at the first entity in front of
 *                 the ship's nose.
 *
 * The server is the single source of truth for rate / energy /
 * range / LOS / target validity; the client's fire intent is a
 * hint, not a claim. A client sending `fire` faster than the
 * weapon's `rate` gains nothing — denied fires cost no energy
 * and surface no FX (TASK-43 acceptance).
 */
export const FireSchema = z
  .object({
    weapon: z.enum(["laser", "missile"]),
    targetId: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * `fire_ok` — TASK-43 server-only ack for `fire`.
 *
 * Returns the resolved fire so the client can render the FX
 * synchronously with the server's `combat_event` (a laser
 * returns `kind: 'laser'` immediately; a missile returns
 * `kind: 'missile'` with a `projectileId` so the client can
 * track the projectile through snapshots).
 *
 *   - `kind: 'laser'`   — instant ray. `damage` is what the
 *                         resolver applied (0 on a missed shot,
 *                         otherwise the weapon's `damage`). The
 *                         muzzle spark fires synchronously.
 *   - `kind: 'missile'` — projectile entity spawned. The
 *                         `projectileId` matches the missile's
 *                         `SimEntity.id` so the client can
 *                         interpolate the tracer until the
 *                         snapshot (≤ 100 ms later) carries the
 *                         same id.
 *   - `kind: 'denied'`  — fire rejected (rate / energy /
 *                         weapon-locked / range / weapon-not-
 *                         equipped / self-target / no-target).
 *                         Client HUD must NOT render any FX on
 *                         this path — the spec is explicit
 *                         ("a denied fire shows no FX").
 *
 * The server still broadcasts a `combat_event { kind: 'hit' }`
 * for accepted laser hits; the ack is purely so the firing
 * client can synchronise its muzzle spark with the broadcast.
 */
export const FireOkSchema = z
  .object({
    weapon: z.enum(["laser", "missile"]),
    kind: z.enum(["laser", "missile", "denied"]),
    /** Damage applied (laser hit; 0 if the laser missed). */
    damage: z.number().finite().nonnegative(),
    /** Missile projectile id (`kind === 'missile'` only). */
    projectileId: z.string().min(1).nullable(),
    /** Energy remaining after this fire (or unchanged on deny). */
    energy: z.number().finite().nonnegative(),
    /** Code on `kind === 'denied'` — surfaces as a wire error code. */
    denialCode: z
      .enum([
        "rate-limited",
        "low-energy",
        "weapon-locked",
        "weapon-not-equipped",
        "out-of-range",
        "not-attackable",
        "self-target",
        "no-target",
        "unknown",
      ])
      .nullable(),
  })
  .strict();

/**
 * `weapon_state` — TASK-43 server → owning client broadcast of
 * the local player's energy + active weapon + lockout state.
 *
 * Lives on its own frame (rather than being jammed into the
 * `entity_update` payload) because:
 *
 *   - the cadence is independent of the 10 Hz snapshot (the
 *     server pushes this whenever energy crosses a tick boundary
 *     or the lockout state changes — typically every shot),
 *   - a denied fire would never produce a `combat_event`, but the
 *     HUD still wants to know "your energy is now 0" so the
 *     `LOW ENERGY` prompt can flip on the same frame the player
 *     tried to fire.
 *
 * Pushed only to the owning connection (NOT broadcast to the
 * shard — every player has their own energy state).
 */
export const WeaponStateSchema = z
  .object({
    /** Currently equipped weapon (`'laser' | 'missile'`). */
    activeWeapon: z.enum(["laser", "missile"]),
    /** Energy remaining. Always [0, ENERGY_MAX]. */
    energy: z.number().finite().nonnegative(),
    /** True while the connection is in the anti-spam lockout window. */
    locked: z.boolean(),
    /** Wall-clock ms when the lockout expires (0 when not locked). */
    lockedUntilMs: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `select_weapon` — TASK-43 client → server weapon-cycle intent.
 *
 * Triggered by the `1` / `2` keys. The server validates the
 * requested id is in the player's loadout (a scout requesting
 * `missile` is silently accepted but the HUD renders "weapon
 * not equipped" because `fire` will be rejected).
 */
export const SelectWeaponSchema = z
  .object({
    weapon: z.enum(["laser", "missile"]),
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
    action: z.enum([
      "pickup-full",
      "pickup-partial",
      "drop",
      "set",
      // TASK-38: emitted by the mining state machine. `mine-progress`
      // accompanies every successful unit award; `mine-paused-full`
      // signals the channel paused because the inventory is full
      // (client can render a "Backpack full" prompt).
      "mine-progress",
      "mine-paused-full",
    ]),
    /** Resources taken on the triggering event (0 for `set`). */
    taken: z.number().int().nonnegative(),
    /** Resources left on the source after a partial pickup (0 for full). */
    remaining: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `mine` — long-running extraction start (TASK-38).
 *
 * Client claims `duration` (typically the 1.5 s per-unit cadence),
 * but the server is the source of truth: the `duration` field is
 * ignored for awarding. Awards happen on the server's 1.5 s tick
 * cadence regardless of how many `mine` frames the client sends
 * (anti-spam: spam = no gain).
 *
 * `nodeId` is the deposit's entity id (the wire shape carries
 * `deposits` as their own entities, so a deposit id is the same
 * id the proximity-interaction flow uses).
 */
export const MineSchema = z
  .object({
    nodeId: z.string().min(1),
    /** Client-claimed per-unit duration (ms). Ignored by the server. */
    duration: z.number().finite().nonnegative(),
  })
  .strict();

/** `mine_stop` — TASK-38. Client-initiated cancel of a mining channel. */
export const MineStopSchema = z.object({}).strict();

/**
 * `mining_update` — TASK-38. Server→owner progress echo. Carries the
 * server-timed mining state so the client UI never runs its own
 * channel timer. The cadence is bounded to one frame per server
 * tick (20 Hz) when the player is actively mining — the receiving
 * client interpolates between echoes for a smooth radial.
 *
 *   - `state === 'mining'`      — active channel; progress in 0..MINE_TICK_MS.
 *   - `state === 'paused-full'` — paused because the inventory is full.
 *                                  `progressMs` === 0 because the cadence
 *                                  doesn't advance while paused.
 *   - `state === 'depleted'`    — the deposit hit zero; the channel
 *                                  closed cleanly. The client should
 *                                  hide the radial and toast "Depleted".
 *   - `state === 'cancelled'`   — the channel was cancelled (player
 *                                  stopped, walked out of range, or
 *                                  the connection dropped). No award
 *                                  on cancel.
 *
 * The owning connection receives every echo; other clients see the
 * deposit's `amount` decrease in the regular 10 Hz `entity_update`.
 */
export const MiningUpdateSchema = z
  .object({
    depositId: z.string().min(1),
    resourceId: z.string().min(1),
    /** Server-time elapsed (ms) within the current 1.5 s unit. */
    progressMs: z.number().finite().nonnegative(),
    /** Units awarded in this channel so far. */
    unitsSoFar: z.number().int().nonnegative(),
    /** Current amount remaining on the deposit. */
    amount: z.number().int().nonnegative(),
    /** Channel state (see doc above). */
    state: z.enum(["mining", "paused-full", "depleted", "cancelled"]),
  })
  .strict();

/**
 * TASK-48: `hazard_update` — server-only, per-player broadcast
 * that surfaces the local player's exposure + recovering state so
 * the HUD's radiation meter can render. The frame is pushed to
 * the owning connection only (not the whole shard) — exposure is
 * a personal resource and never broadcast to other players.
 *
 * `exposure` is the current personal-shield pool (0..50). The HUD
 * renders a bar; when the pool reaches 0 the player is knocked to
 * `recovering` for 5 s.
 *
 * `recoveringUntilMs` is the wall-clock ms timestamp at which the
 * recover ends; `0` when not recovering. The HUD reads this to
 * switch the prompt to "RECOVERING" + block input (the sim
 * already gates input on the recover state).
 *
 * `recentDamage` (optional) is the last `intensity * dt` delta the
 * server applied this tick. The HUD uses it for a quick flash
 * animation when the meter ticks down (so the player sees the
 * damage land, not just the final value).
 */
/**
 * One hazard cell as streamed to the client (TASK-48).
 *
 * Cells are seed-derived on both sides, but the server owns
 * which ones are *near* the player (it already walks the cell
 * map for the exposure pass), so it ships the culled list on the
 * `hazard_update` frame instead of making the client re-derive
 * placement. `kind` drives the client's disc colour:
 * storm (violet swirl), radzone (green glow), drones (cell only —
 * the drones inside stream as `kind: 'drone'` entities).
 */
export const HazardCellWireSchema = z
  .object({
    hazardId: z.string().min(1),
    kind: z.enum(["storm", "radzone", "drones"]),
    /** World-space `[x, y, z]` centre. */
    pos: z.tuple([z.number(), z.number(), z.number()]),
    /** Cell radius in metres (100..400). */
    radius: z.number().finite().positive(),
    /** Damage per second (0 for drone cells). */
    intensity: z.number().finite().nonnegative(),
  })
  .strict();

export const HazardUpdateSchema = z
  .object({
    exposure: z.number().finite().min(0).max(50),
    recoveringUntilMs: z.number().int().nonnegative(),
    /** When true, the player is currently inside a hazard cell. */
    inHazard: z.boolean(),
    /** Optional: last single-tick exposure damage (for HUD flash). */
    recentDamage: z.number().finite().nonnegative().optional(),
    /**
     * TASK-52: optional pointer to the hazard cell the player is
     * *currently* inside. Drives the on-foot exposure meter's icon
     * (radiation glyph for `radzone`, swirl glyph for `storm`,
     * drone glyph for `drones`). Absent when `inHazard === false`
     * — the client falls back to a neutral hazard glyph. Optional
     * because the v1 server culls this only while the player is
     * inside a cell; every other frame keeps the previously
     * reported `currentHazard` and lets it clear via `inHazard`.
     */
    currentHazard: HazardCellWireSchema.optional(),
    /**
     * Optional: hazard cells within `HAZARD_VISIBLE_RANGE_M` of the
     * player, for the in-world disc renderer. Absent when the
     * player is nowhere near a hazard (the common case).
     */
    cells: z.array(HazardCellWireSchema).max(16).optional(),
    /**
     * Optional: the player's own world anchor (character or ship
     * position) used for the exposure pass. The client uses it as
     * the centre of the hazard scope so discs are drawn relative
     * to "here" rather than absolute world coords.
     */
    anchor: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .strict();

/**
 * `sell` — dock sell action (TASK-40).
 *
 * The client sends `{ resourceType, quantity, source? }` after
 * confirming "I'm at the station". The server validates "at a
 * station" against the bound entity (ship → must be `onPad !== null`,
 * character → must be within 10 m of a docked ship's terminal) and
 * debits the source stack (cargo hold or on-foot inventory) by
 * `quantity * basePrice` worth of credits.
 *
 * The `source` field is OPTIONAL — the server defaults it from the
 * bound entity kind (ship → `'hold'`, character → `'inv'`). A
 * mismatched explicit `source` surfaces as `invalid-amount` (the
 * caller is trying to sell from a side they aren't physically
 * associated with).
 */
export const SellSchema = z
  .object({
    resourceType: z.string().min(1),
    quantity: z.number().int().positive(),
    source: z.enum(["inv", "hold"]).optional(),
  })
  .strict();

/**
 * `sell_ok` — server-only ack for `sell` (TASK-40).
 *
 * Carries the credit + stack deltas so the client HUD can render
 * the "+240 cr" floating text on the same frame the credits
 * counter updates. `newBalance` is the post-credit balance; the
 * client should also receive a follow-up `inventory_update` /
 * `cargo_update` carrying the new source shape if it subscribes
 * to those streams.
 */
export const SellOkSchema = z
  .object({
    resourceType: z.string().min(1),
    quantity: z.number().int().positive(),
    sold: z.number().int().nonnegative(),
    earned: z.number().int().nonnegative(),
    newBalance: z.number().int().nonnegative(),
    source: z.enum(["inv", "hold"]),
  })
  .strict();

/**
 * `cargo_transfer` — TASK-39. The on-foot player triggers a move
 * between their backpack and the docked ship's cargo hold.
 *
 *   - `resourceId` — the resource stack being moved (validated
 *                   against the shared inventory catalog at the
 *                   server boundary; the wire shape is free-form so
 *                   the catalog can grow without a protocol bump).
 *   - `amount`     — positive integer; partial moves land when
 *                   the destination cap is reached (the handler
 *                   reports `transferred` + `remaining` in the
 *                   `cargo_update` ack).
 *   - `from`       — `'inv'` moves inventory → cargo hold;
 *                   `'hold'` moves cargo hold → inventory. The
 *                   source must own the full `amount` (a partial
 *                   ownership row surfaces as `insufficient-amount`).
 *
 * The server validates proximity (5 m of own docked ship),
 * ownership, and the destination cap before persisting either
 * shape. Both writes are atomic: a crash between the inventory
 * and cargo save rolls back the inventory (the hold update is the
 * second write; the DB doesn't expose a cross-table transaction
 * to the repository, but `saveInventory` / `saveShipState` are
 * each one UPDATE, so a crash window is bounded to the time
 * between two consecutive writes — and the spec accepts that
 * for v1 with the documented "no infinite recovery" trade-off).
 */
export const CargoTransferSchema = z
  .object({
    resourceId: z.string().min(1),
    amount: z.number().int().positive(),
    from: z.enum(["inv", "hold"]),
  })
  .strict();

/**
 * `cargo_update` — TASK-39. Server-pushed ack for a successful
 * `cargo_transfer`. Carries the new hold + inventory shapes so
 * the client HUD can render both side by side without a second
 * round-trip. The `action` discriminator drives the toast
 * feedback ("Loaded into hold" / "Unloaded to backpack") so the
 * client doesn't have to interpret the direction field twice.
 *
 *   - `direction`   — echoes the request's `from` so a client
 *                     can correlate the ack with its own in-
 *                     flight transfer id (future TASK-58
 *                     multi-slot UI).
 *   - `transferred` — how many units actually moved (≤
 *                     `amount`). A partial move is intentional:
 *                     the destination cap reached before the
 *                     full stack fit, the remainder stays in
 *                     the source.
 *   - `remaining`   — units that DIDN'T fit (0 on full
 *                     transfers, > 0 on partial).
 */
export const CargoUpdateSchema = z
  .object({
    cargo: z
      .object({
        stacks: z.record(z.string(), z.number().int().nonnegative()),
        weightUsed: z.number().finite().nonnegative(),
        capacity: z.number().int().positive(),
      })
      .strict(),
    inventory: z
      .object({
        stacks: z.record(z.string(), z.number().int().nonnegative()),
        weightUsed: z.number().finite().nonnegative(),
        capacity: z.number().int().positive(),
      })
      .strict(),
    direction: z.enum(["inv", "hold"]),
    resourceId: z.string().min(1),
    transferred: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    action: z.enum(["move-to-hold", "move-to-inventory"]),
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

/**
 * `enter_ship_ok` — server-only ack for `enter_ship` (TASK-35).
 *
 * Mirrors the `interact_ok` shape: the success path itself is
 * idempotent (no broadcast change — the server just rebinds the
 * connection's `entityId` from the character to the ship and
 * drops the character entity), so the next `entity_update` IS
 * the confirmation. The explicit ack lets the client surface a
 * "Boarded <callsign>" toast on the same frame the controls
 * flip back to the flight scheme.
 */
export const EnterShipOkSchema = z
  .object({
    /** The now-active ship entity id (matches the wire's `EntityState.id`). */
    shipId: z.string().min(1),
  })
  .strict();

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
    /**
     * TASK-44: ship target's callsign (display label). Mirrors the
     * `EntityState.callsign` field. Absent on AI targets (their wire
     * callsign is `null`).
     */
    callsign: z.string().min(1).nullable(),
    /**
     * TASK-44: the ship's class id (`'scout' | 'freighter' | 'interceptor'`)
     * or `null` for AI targets without a class label.
     */
    classId: ShipClassIdSchema.nullable(),
  })
  .strict();

/**
 * `target_lock` — TASK-44 client → server lock-on intent. The
 * server validates range (500 m), cone (30°), target kind (ships
 * only), and target liveness (`hull > 0`). On accept the server
 * echoes `target_locked`; on rejection it surfaces `invalid-target`.
 *
 * If the player is already locking a target, this frame toggles the
 * lock off (releasing is the T-dual behaviour per TASK-44 acceptance).
 *
 * `targetId` is the entity id of the desired lock target. Passing
 * `null` is the "release whatever you have locked" path.
 */
export const TargetLockSchema = z
  .object({
    targetId: z.string().min(1).nullable().optional(),
  })
  .strict();

/** `target_locked` — TASK-44 server → client success ack for `target_lock`. */
export const TargetLockedSchema = z
  .object({
    targetId: z.string().min(1),
    callsign: z.string().min(1).nullable(),
    range: z.number().finite().nonnegative(),
    bearing: z.number().finite(),
    lockedAt: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `target_released` — TASK-44 server → client broadcast on lock
 * release (toggle, destroyed target, range exit, or 30 s timeout).
 * Carries the released target id (or `null` when there was no
 * active lock) so the HUD can drop its box.
 */
export const TargetReleasedSchema = z
  .object({
    targetId: z.string().min(1).nullable(),
    /**
     * Reason for the release. HUD toasts map these onto messages:
     *   - `'toggle'`         — player re-pressed T.
     *   - `'destroyed'`      — target hull reached 0.
     *   - `'range-exceeded'` — target exited 1500 m.
     *   - `'timeout'`        — 30 s elapsed since lock.
     *   - `'manual'`         — `target_release` frame.
     *   - `'snapshot'`       — initial empty release on disconnect.
     */
    reason: z.enum(["toggle", "destroyed", "range-exceeded", "timeout", "manual", "snapshot"]),
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
          kind: z.enum(["player", "ai", "drone"]),
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
          kind: z.enum(["player", "ai", "drone"]),
          id: z.string().min(1),
        })
        .strict(),
      tick: z.number().int().nonnegative(),
      // TASK-49: respawn summary. Present only when the destroyed
      // ship belonged to a connected player — the client uses it to
      // drive the 2 s "SHIP LOST" moment (callsign, killer, "Respawning
      // at <nearest dock>"). The server has already respawned the
      // player by the time this frame lands; the payload is
      // presentation only.
      respawn: z
        .object({
          wreckId: z.string().min(1),
          padId: z.string(),
          planetId: z.string(),
          callsign: z.string().min(1),
          killer: z.string().nullable(),
          cargoLost: z.record(z.string(), z.number().finite().nonnegative()),
        })
        .strict()
        .optional(),
    })
    .strict(),
  // TASK-46: an AI has begun its 1 s acquire timer on a player.
  // Pushed directly to the targeted player's connection via
  // `shard.send` so the local HUD can render an "ACQUIRING" toast.
  // Wire-level source attribution mirrors the `damaged` /
  // `destroyed` events so the client-side parser can reuse the
  // same code path.
  z
    .object({
      kind: z.literal("ai_acquiring"),
      source: z
        .object({
          kind: z.literal("ai"),
          id: z.string().min(1),
          callsign: z.string().nullable(),
        })
        .strict(),
      target: z.string().min(1),
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
  fire: FireSchema,
  fire_ok: FireOkSchema,
  weapon_state: WeaponStateSchema,
  select_weapon: SelectWeaponSchema,
  warp: WarpSchema,
  interact: InteractSchema,
  interact_ok: InteractOkSchema,
  ui_open: UiOpenSchema,
  pickup: PickupSchema,
  drop: DropSchema,
  inventory_update: InventoryUpdateSchema,
  mine: MineSchema,
  mine_stop: MineStopSchema,
  mining_update: MiningUpdateSchema,
  hazard_update: HazardUpdateSchema,
  sell: SellSchema,
  sell_ok: SellOkSchema,
  cargo_transfer: CargoTransferSchema,
  cargo_update: CargoUpdateSchema,
  buy_ship: BuyShipSchema,
  set_livery: SetLiverySchema,
  exit_ship: ExitShipSchema,
  enter_ship: EnterShipSchema,
  enter_ship_ok: EnterShipOkSchema,
  repair: RepairSchema,
  logout: LogoutSchema,
  logout_ok: LogoutOkSchema,
  error: ErrorSchema,
  ping: PingSchema,
  pong: PongSchema,
  presence: PresenceSchema,
  target_update: TargetUpdateSchema,
  target_lock: TargetLockSchema,
  target_locked: TargetLockedSchema,
  target_released: TargetReleasedSchema,
  combat_event: CombatEventSchema,
  warp_arrived: WarpArrivedSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

/** Discriminated union of every supported message type name. */
export type MessageType = keyof typeof PAYLOAD_SCHEMAS;

/** Companion payload type derived from a `MessageType`. */
export type PayloadFor<T extends MessageType> = z.infer<(typeof PAYLOAD_SCHEMAS)[T]>;

/** Convenience: list of every message type as an array. */
export const MESSAGE_TYPES = Object.keys(PAYLOAD_SCHEMAS) as MessageType[];
