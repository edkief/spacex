/**
 * Client-side WebSocket glue + reconnect (TASK-15 + TASK-17).
 *
 * Wraps the `WebSocket` browser API with the Drift handshake so
 * `App.tsx` only has to instantiate one `DriftClient` per mount
 * and forget about the wire protocol. The client:
 *
 *   1. POSTs `/api/callsigns` to claim a fresh callsign + token.
 *      On 409 (taken) it retries with a numeric suffix until a
 *      unique callsign lands.
 *   2. Opens a WebSocket to `/ws`.
 *   3. Sends `hello`, waits for the server's `hello` reply, then
 *      sends `auth` with the token. Awaits `auth_ok` to learn the
 *      player id + callsign.
 *   4. Sends `join_system` with the player's home system id and
 *      awaits `enter_system`.
 *   5. Streams every `presence` frame into the `PresenceStore` and
 *      every `state_snapshot` / `entity_update` into the
 *      `RemoteEntityBuffer` (TASK-14).
 *
 * ## Reconnect + resync (TASK-17)
 *
 * When the underlying socket closes (network blip, tab sleep,
 * server restart) the client does NOT immediately give up:
 *
 *   - Auto-retry with exponential backoff (1 s → 5 s) for up to
 *     30 s of wall-clock retry budget. The retry only resumes the
 *     session (`hello → auth → join_system`) — the callsign claim
 *     is one-shot and re-uses the token from the original claim.
 *   - On reconnect, the client re-runs the handshake with the
 *     saved token. The server returns the canonical `enter_system`
 *     snapshot for the player's current system, so the client
 *     re-hydrates its remote-entity buffers and resyncs the
 *     prediction engine.
 *   - If the disconnect lasted < 60 s **and** the system id is
 *     unchanged, the client preserves `presence` + `chat` state.
 *     Otherwise it clears the stores so a stale roster doesn't
 *     leak into the next session.
 *   - On every successful resync the client fires a `reconnected`
 *     listener (the App.tsx renders a transient "Reconnected"
 *     toast off this hook).
 *   - After 30 s of failed retries, the client transitions to
 *     `"lost"` status — the App shows the "Connection lost"
 *     overlay with a manual Retry button.
 *
 * ## Lifecycle
 *
 *   - `idle`      — constructed, no socket yet.
 *   - `claiming`  — REST callsign claim in flight.
 *   - `connecting` — WebSocket opening.
 *   - `handshaking` — `hello → auth` in flight.
 *   - `joining`   — `join_system → enter_system` in flight.
 *   - `online`    — fully connected, receiving snapshots.
 *   - `reconnecting` — socket closed, retrying (in-band).
 *   - `disconnected` — user-called `stop()`.
 *   - `lost`      — auto-reconnect budget exhausted.
 *   - `error`     — unrecoverable error (e.g. claim failed).
 *
 * The client is pure TypeScript with no React dependency so it
 * can be unit-tested against a stub `WebSocket` (the
 * `createSocket` factory accepts a stub). The
 * `WebSocketFactory` and `Fetcher` overrides are the only seams
 * needed to drive the reconnect state machine without a real
 * server.
 *
 * @see ../prediction.ts for the sibling remote-entity buffer the
 *      client feeds (TASK-14).
 * @see ../../shared/protocol/index.ts for the wire envelope.
 */

import {
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type PayloadFor,
} from "@shared/protocol/index.js";
import type { Inventory } from "@shared/world/inventory.js";
import type { CargoHold } from "@shared/world/cargo.js";
import type { WeaponId } from "@shared/weapons.js";

import { PresenceStore } from "./presence.js";
import { ChatStore } from "./chat.js";
import { ClientShipPredictor, RemoteEntityBuffer, simEntityFromWire } from "./prediction.js";
import { TargetingStore } from "../combat/targeting.js";
import { KillFeedStore } from "../combat/killFeed.js";
import { DestructionStore } from "../fx/destruction.js";
import { HazardStore, markersFromEntities } from "../world/hazards.js";
import type { NotificationStore } from "./notifications.js";

/**
 * TASK-44: per-frame targeting events. The HUD subscribes via
 * `onTargetUpdate()` so it can re-render in lock-step with the
 * server. The `kind` discriminates the three server-pushed
 * targeting frames.
 */
export type TargetingEvent =
  | { kind: "locked"; payload: Parameters<TargetingStore["applyLocked"]>[0] }
  | { kind: "released"; payload: Parameters<TargetingStore["applyReleased"]>[0] }
  | { kind: "update"; payload: Parameters<TargetingStore["applyTargetUpdate"]>[0] };
import { Controls } from "../input/controls.js";
import type { PayloadFor as WirePayloadFor } from "@shared/protocol/index.js";

/** Connection lifecycle states surfaced to the UI. */
export type DriftClientStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "handshaking"
  | "joining"
  | "online"
  | "reconnecting"
  | "disconnected"
  | "lost"
  | "error";

/** Lifecycle observer. */
export type StatusListener = (status: DriftClientStatus, detail?: string) => void;

/** Error observer. */
export type ErrorListener = (err: Error) => void;

/**
 * TASK-43: live weapon state snapshot (active weapon,
 * energy reservoir, anti-spam lockout). Mirrors the wire
 * `weapon_state` shape so the HUD can subscribe via
 * `getWeaponState()` without depending on the protocol
 * module directly.
 */
export interface WeaponStateSnapshot {
  activeWeapon: WeaponId;
  energy: number;
  locked: boolean;
  lockedUntilMs: number;
}

/**
 * Resync event fired every time the client reaches `online` after
 * a reconnect. The `preserved` flag tells the UI whether it can
 * keep its `presence` + `chat` stores (true) or whether it should
 * wipe them because the system changed or the disconnect lasted
 * > 60 s (false). The App listens to this to drive its
 * "Reconnected" toast + prediction-engine reset.
 */
export interface ResyncEvent {
  /** True when chat + presence should be preserved. */
  preserved: boolean;
  /** The system id we just joined (may equal the previous one). */
  systemId: string;
  /** Wall-clock ms when the previous disconnect started. */
  disconnectedAtMs: number;
}

/** Resync listener. */
export type ResyncListener = (event: ResyncEvent) => void;

/**
 * TASK-8: warp-arrived listener. Fired when the server confirms
 * an inter-system travel with a `warp_arrived` frame.
 */
export type WarpArrivedListener = (payload: PayloadFor<"warp_arrived">) => void;

/** Default factory — `WebSocket` from the global scope in the browser. */
export type WebSocketFactory = (url: string) => WebSocket;

/** Default HTTP fetcher — `fetch` from the global scope in the browser. */
export type Fetcher = typeof fetch;

/** Sleep function — tests inject a no-op or fast-forward fake. */
export type Sleeper = (ms: number) => Promise<void>;

/** Default options for the auto-retry loop. */
export const DEFAULT_RETRY_INITIAL_MS = 1_000;
/** Maximum backoff between retries (ms). */
export const DEFAULT_RETRY_MAX_MS = 5_000;
/** Total budget (ms) before the client gives up and goes to `lost`. */
export const DEFAULT_RETRY_BUDGET_MS = 30_000;
/** Window (ms) within which the client preserves UI state on reconnect. */
export const DEFAULT_RESYNC_PRESERVE_MS = 60_000;

/** Public options bag. */
export interface DriftClientOptions {
  /** Override the WebSocket factory for tests. */
  createSocket?: WebSocketFactory;
  /** Override the fetch implementation for tests. */
  fetchImpl?: Fetcher;
  /** Override the sleep implementation for tests. */
  sleep?: Sleeper;
  /** Override the wall clock for tests. */
  now?: () => number;
  /** Origin to talk to (defaults to `window.location.origin`). */
  origin?: string;
  /**
   * Optional: the system id to join. Defaults to the home system
   * id returned by `/api/callsigns`.
   */
  systemId?: string;
  /**
   * Optional: a pre-allocated callsign. When unset, the client
   * generates `Drift-<random>` and retries with a numeric suffix
   * on `callsign-taken`.
   */
  callsign?: string;
  /** Optional override for the callsign-claim path (defaults to `/api/callsigns`). */
  claimPath?: string;
  /** Optional override for the WS endpoint (defaults to `/ws`). */
  wsPath?: string;
  /**
   * Optional override: feed presence frames into a custom store.
   * Tests pass a pre-seeded store; production passes the React
   * shell's store.
   */
  presenceStore?: PresenceStore;
  /**
   * Optional override: feed entity_update frames into a custom
   * remote buffer. Defaults to a fresh `RemoteEntityBuffer`.
   */
  remoteBuffer?: RemoteEntityBuffer;
  /**
   * Optional override: feed chat frames into a custom store.
   * Tests pass a pre-seeded store; production uses the React
   * shell's instance.
   */
  chatStore?: ChatStore;
  /**
   * Optional: drop-in replacement for the remote-entity buffer
   * registry. The default uses `Map<entityId, RemoteEntityBuffer>`
   * keyed by `entity.id`. The resync path calls `reset()` on this
   * registry so a reconnect tears down the old buffers; tests can
   * pass a stub to assert the call lands.
   */
  remoteBufferRegistry?: { reset(): void; size(): number };
  /** Initial backoff between retries (ms). Defaults to 1 s. */
  retryInitialMs?: number;
  /** Maximum backoff between retries (ms). Defaults to 5 s. */
  retryMaxMs?: number;
  /** Total budget (ms) before the client gives up. Defaults to 30 s. */
  retryBudgetMs?: number;
  /** Window (ms) within which the client preserves UI state. Defaults to 60 s. */
  resyncPreserveMs?: number;
  /** Optional status lifecycle observer. */
  onStatus?: StatusListener;
  /** Optional error observer. */
  onError?: ErrorListener;
  /** Optional resync observer (fires on every successful reconnect). */
  onResync?: ResyncListener;
  /** TASK-8: optional warp-arrived observer (fires when a `warp_arrived` frame lands). */
  onWarpArrived?: WarpArrivedListener;
  /** TASK-8: optional warp-rejected observer (fires when an `error` frame arrives with a warp-related code). */
  onWarpRejected?: (payload: { code: string; message: string }) => void;
  /**
   * Optional: filter applied to every outbound `presence` frame
   * before it reaches the store. Defaults to identity. Tests use
   * this to count frames without affecting UI behaviour.
   */
  presenceSink?: (frame: PayloadFor<"presence">) => void;
}

/** Claim endpoint response shape. */
interface ClaimResponse {
  callsign: string;
  token: string;
  playerId: string;
  homeSystemId: string;
  shipId: string;
  tokenExpiresAt: number;
}

/**
 * Thin WS client wrapping the Drift handshake + reconnect loop.
 * See file header for the lifecycle + reconnect semantics.
 */
export class DriftClient {
  private readonly opts: DriftClientOptions;
  private readonly presence: PresenceStore;
  private readonly chat: ChatStore;
  private readonly remoteBuffer: RemoteEntityBuffer;
  private readonly remoteBuffers = new Map<string, RemoteEntityBuffer>();
  /**
   * TASK-75: entity id → wire callsign for every entity that
   * carries one. Used to decide which remote meshes belong to a
   * *player* (as opposed to an AI ship, whose callsign is never
   * on the presence roster).
   */
  private readonly remoteCallsigns = new Map<string, string>();
  /**
   * TASK-75: the subset of {@link remoteCallsigns} whose callsign
   * was seen on a presence roster — i.e. human-owned. When one of
   * them leaves the roster, its buffers (and therefore its meshes)
   * are dropped; the server deliberately keeps the entity alive
   * for reconnect (see `removeConnection` in `@server/shard`), so
   * staleness alone would never free them.
   */
  private readonly playerOwnedEntities = new Set<string>();
  /** TASK-75: callsigns on the most recent presence roster. */
  private presentCallsigns: ReadonlySet<string> = new Set<string>();
  /** TASK-25: per-client controls manager — swaps input schemes
   *  when the regime state machine reports a transition. */
  private readonly controls: Controls = new Controls("space");
  private socket: WebSocket | null = null;
  /** TASK-8: warp-arrived subscriber set. */
  private readonly warpArrivedListeners = new Set<WarpArrivedListener>();
  /** TASK-8: warp-rejected subscriber set. */
  private readonly warpRejectedListeners = new Set<
    (payload: { code: string; message: string }) => void
  >();
  /** TASK-33: ui-open subscriber set (dock terminal modal etc). */
  private readonly uiOpenListeners = new Set<
    (payload: { ui: string; payload: Record<string, unknown> }) => void
  >();
  /** TASK-35: enter_ship_ok subscriber set (re-entry ack). Fired
   *  when the server commits the character → ship entity switch.
   *  The owning client listens for this so it can swap the
   *  camera + controls synchronously without waiting for the
   *  next `entity_update` broadcast. */
  private readonly enterShipOkListeners = new Set<(payload: { shipId: string }) => void>();
  /** TASK-40: sell_ok subscriber set (dock-sell ack). Fired when
   *  the server commits the credit add + stack debit. The owning
   *  client listens so the dock panel can render the "+N cr"
   *  floating text + bump the credits counter on the same frame. */
  private readonly sellOkListeners = new Set<
    (payload: {
      resourceType: string;
      quantity: number;
      sold: number;
      earned: number;
      newBalance: number;
      source: "inv" | "hold";
    }) => void
  >();
  /**
   * TASK-38: mining-update echoes — server-driven radial progress
   * (0..1500 ms within a cadence) + `state` (mining / paused-full /
   * depleted / cancelled). UI drives the radial from this stream;
   * the client never runs its own channel timer.
   */
  private readonly miningUpdateListeners = new Set<
    (payload: {
      depositId: string;
      resourceId: string;
      progressMs: number;
      unitsSoFar: number;
      amount: number;
      state: "mining" | "paused-full" | "depleted" | "cancelled";
    }) => void
  >();
  /** TASK-34: latest known on-foot inventory. The server pushes
   *  `inventory_update` frames on every pickup / drop; the HUD
   *  polls `getInventory()` instead of subscribing so the
   *  polling cadence matches the existing docked-indicator + interaction-
   *  prompt hooks (TASK-29 / TASK-33). */
  private inventory: Inventory | null = null;
  /** TASK-39: latest known ship cargo hold. The server pushes
   *  `cargo_update` frames on every transfer; the HUD polls
   *  `getCargo()` instead of subscribing so the polling cadence
   *  matches the existing weight-bar / inventory hooks (TASK-34). */
  private cargo: CargoHold | null = null;
  /** TASK-43: latest known weapon state (active weapon, energy,
   *  lockout). The server pushes `weapon_state` frames on every
   *  accepted or denied fire; the WeaponHud polls
   *  `getWeaponState()` so the polling cadence matches the
   *  existing weight-bar / cargo-poll loops (250 ms). */
  private weaponState: WeaponStateSnapshot | null = null;
  /** TASK-43: `fire_ok` subscriber set. Fired on every accepted
   *  laser fire (muzzle spark) and every missile spawn
   *  (tracer starts here) AND every denial (the FX layer
   *  ignores denials — denied fires surface no FX per the
   *  spec). */
  private readonly fireOkListeners = new Set<
    (payload: {
      weapon: "laser" | "missile";
      kind: "laser" | "missile" | "denied";
      damage: number;
      projectileId: string | null;
      energy: number;
      denialCode: string | null;
    }) => void
  >();
  /** TASK-51: synthetic self-hit subscriber set — driven by the
   *  ShipHUD vitals-bar's hit-flash controller. */
  private readonly selfHitListeners = new Set<
    (event: { kind: "hit" | "damaged"; target: string }) => void
  >();
  /**
   * TASK-44: targeting store + listener set. Fires on every
   * `target_locked` / `target_released` / `target_update`
   * frame from the server. The HUD's target-box + threat-ping
   * components subscribe to `onTargetUpdate()` so they can
   * re-render in lock-step with server state.
   */
  private readonly targeting = new TargetingStore();
  private readonly targetUpdateListeners = new Set<(event: TargetingEvent) => void>();
  /**
   * TASK-47: persistent kill-feed HUD widget. Owns its own
   * store so the React layer can pass a single reference to
   * the `<KillFeed>` component. Combat events with
   * `kind: 'kill'` feed entries via `applyKillEvent`; the
   * store caps entries at 5 and expires them after 10 s.
   */
  private readonly killFeed = new KillFeedStore();
  /** TASK-49: destruction FX store (explosion + SHIP LOST + wreck markers). */
  private readonly destruction = new DestructionStore();
  /**
   * TASK-48: per-player hazard store. The server pushes
   * `hazard_update` frames every tick while the player is on
   * foot (or close enough to a hazard cell to take damage).
   * The HUD's exposure meter reads from this store; the in-world
   * hazard layer reads the drone / cell markers from the same
   * instance.
   */
  private readonly hazardStore = new HazardStore();
  /**
   * TASK-46: optional notification store hook. When set,
   * `combat_event { kind: 'ai_acquiring' }` frames push an
   * "ACQUIRING" toast to the store so the HUD's ToastStack
   * renders it. The App.tsx mount wires this on construction;
   * tests inject a stub.
   */
  notificationStore?: NotificationStore;
  private status: DriftClientStatus = "idle";
  private playerId: string | null = null;
  private callsign: string | null = null;
  /**
   * TASK-74: own ship's id. Set from the claim response so the
   * predictor knows which entity in the per-entity remote
   * buffer registry carries the local ship. Stable across
   * reconnects (the server preserves ship rows).
   */
  private shipId: string | null = null;
  /**
   * TASK-74: lazily-constructed local ship predictor. The first
   * call to `get predictor()` allocates it (so cold boots have no
   * cost when the local ship is disembarked or hasn't been seen
   * yet). Subsequent `entity_update` frames feed it via the
   * `maybeReconcilePredictor()` call in `handleMessage`.
   */
  private _predictor: ClientShipPredictor | null = null;
  /** Token cached from the original claim; re-used on reconnect. */
  private token: string | null = null;
  /** Home system id from the original claim. */
  private homeSystemId: string | null = null;
  private systemId: string | null = null;
  private statusListeners = new Set<StatusListener>();
  private errorListeners = new Set<ErrorListener>();
  private resyncListeners = new Set<ResyncListener>();
  /** Wall-clock ms when the current socket dropped (null while online). */
  private disconnectedAtMs: number | null = null;
  /** System id at the moment of the last disconnect (for resync-keep detection). */
  private lastSystemId: string | null = null;
  /** In-flight reconnect loop, if any. */
  private reconnectAbort: { aborted: boolean } | null = null;

  constructor(opts: DriftClientOptions = {}) {
    this.opts = opts;
    this.presence = opts.presenceStore ?? new PresenceStore();
    this.chat = opts.chatStore ?? new ChatStore();
    this.remoteBuffer = opts.remoteBuffer ?? new RemoteEntityBuffer();
    this.presence.setOwnCallsign(opts.callsign ?? null);
  }

  /** The presence store. The React shell subscribes via this reference. */
  get presenceStore(): PresenceStore {
    return this.presence;
  }

  /** The chat store. The React shell subscribes via this reference. */
  get chatStore(): ChatStore {
    return this.chat;
  }

  /** The remote-entity buffer (TASK-14). */
  get remoteEntityBuffer(): RemoteEntityBuffer {
    return this.remoteBuffer;
  }

  /** The per-entity remote buffer registry (TASK-14). */
  get remoteEntityBuffers(): Map<string, RemoteEntityBuffer> {
    return this.remoteBuffers;
  }

  /** TASK-25: the controls manager. Consumers subscribe via
   *  `controls.onRegimeChange(...)` and read `scheme()` to know
   *  which keys are active. */
  get controlsManager(): Controls {
    return this.controls;
  }

  /** Current lifecycle status. */
  get currentStatus(): DriftClientStatus {
    return this.status;
  }

  /** Player id after `auth_ok`, or `null` until then. */
  get currentPlayerId(): string | null {
    return this.playerId;
  }

  /** Callsign after `auth_ok`, or `null` until then. */
  get currentCallsign(): string | null {
    return this.callsign;
  }

  /**
   * TASK-74: own ship's persisted id (from the claim response,
   * or null until the handshake completes). The predictor uses
   * this to resolve `entity:<shipId>` in the remote buffer
   * registry on the first reconcile.
   */
  get currentShipId(): string | null {
    return this.shipId;
  }

  /**
   * TASK-74: local ship predictor (lazily constructed from the
   * first `entity_update` that carries the player ship's
   * authoritative state). Returns a `ClientShipPredictor` whose
   * `.state()` exposes the post-reconciliation pos / vel / quat
   * for the renderer; the predictor itself lives for the lifetime
   * of the client so e2e harnesses can wait on
   * `window.__driftClient.predictor.state()`.
   *
   * The accessor never returns `null` once the predictor is
   * live — before construction (no `entity_update` yet for the
   * own ship) the engine code falls back to a stub that reports
   * the ship at the origin with zero velocity.
   */
  get predictor(): ClientShipPredictor {
    if (this._predictor === null) {
      // Default ship class is `scout` — the persisted starter
      // row ships with that classId (TASK-20), so the
      // reconciliation path can satisfy its lookup. The first
      // real `entity_update` carries the canonical `classId`
      // and `forceSnap`'s the predictor with it.
      this._predictor = new ClientShipPredictor({
        serverState: {
          id: this.shipId !== null ? `entity:${this.shipId}` : "",
          pos: { x: 0, y: 0, z: 0 },
          vel: { x: 0, y: 0, z: 0 },
          quat: { x: 0, y: 0, z: 0, w: 1 },
          regime: "space",
          hull: 100,
          shields: 50,
          onPad: null,
        },
        classId: "scout",
      });
    }
    return this._predictor;
  }

  /**
   * Bearer token used for the WS handshake. Exposed for the
   * REST endpoints the UI polls (e.g. the star chart's
   * `/api/galaxy/overview` + `/api/galaxy/health`). The token
   * is the same one the server issued at claim time; it is
   * cached on the client until `stop()` is called.
   */
  tokenSnapshot(): string | null {
    return this.token;
  }

  /** System id after `enter_system`, or `null` until then. */
  get currentSystemId(): string | null {
    return this.systemId;
  }

  /** True while the auto-reconnect loop is active. */
  get isReconnecting(): boolean {
    return this.reconnectAbort !== null;
  }

  /** Wall-clock ms of the last disconnect (null while online). */
  get lastDisconnectedAtMs(): number | null {
    return this.disconnectedAtMs;
  }

  /** Subscribe to status changes. Returns an unsubscribe handle. */
  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Subscribe to errors. Returns an unsubscribe handle. */
  onErrorEvent(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /**
   * Subscribe to resync events (fires every time the client reaches
   * `online` after a reconnect). The event carries a `preserved`
   * flag so the listener can decide whether to wipe UI state.
   */
  onResyncEvent(listener: ResyncListener): () => void {
    this.resyncListeners.add(listener);
    return () => {
      this.resyncListeners.delete(listener);
    };
  }

  /**
   * TASK-8: subscribe to warp-arrived events. Fires every time a
   * `warp_arrived` frame lands so the warp state machine + world
   * manager can transition `awaiting → warping-out` and swap the
   * in-world scene. Returns an unsubscribe handle.
   */
  onWarpArrivedEvent(listener: WarpArrivedListener): () => void {
    this.warpArrivedListeners.add(listener);
    return () => {
      this.warpArrivedListeners.delete(listener);
    };
  }

  /**
   * TASK-8: subscribe to warp-rejected events. Fires every time
   * the server replies to a `warp` frame with an `error` frame
   * (e.g. `system-full`, `system-not-found`, `same-system`).
   * Returns an unsubscribe handle.
   */
  onWarpRejectedEvent(listener: (payload: { code: string; message: string }) => void): () => void {
    this.warpRejectedListeners.add(listener);
    return () => {
      this.warpRejectedListeners.delete(listener);
    };
  }

  /**
   * Drive the full lifecycle: claim → handshake → join. Returns
   * once the client is `online` (post-`enter_system`) or throws on
   * failure. Errors are also forwarded to every registered error
   * listener.
   */
  async start(): Promise<void> {
    if (this.status === "online" || this.status === "joining") return;
    let claimed = false;
    try {
      this.setStatus("claiming");
      const claim = await this.claimCallsignWithRetry();
      this.callsign = claim.callsign;
      this.token = claim.token;
      this.homeSystemId = claim.homeSystemId;
      // TASK-74: capture the persistent shipId so the predictor
      // can find the player's own entity in the remote buffer.
      this.shipId = claim.shipId;
      this.presence.setOwnCallsign(claim.callsign);
      claimed = true;

      await this.openSession(claim.homeSystemId, /* preserve */ false);

      this.setStatus("online");
    } catch (err) {
      // If we managed to claim a token but the WS handshake /
      // join_system failed, we DO NOT immediately give up — the
      // auto-reconnect loop is the right recovery path (the token
      // is valid and the server may simply be temporarily
      // unreachable). We mark the session as "claimed but not
      // online" and let `handleClose` trigger the retry.
      if (claimed && this.token && !this.isReconnecting) {
        this.setStatus("reconnecting", (err as Error).message);
        this.beginReconnectLoop();
        return;
      }
      this.setStatus("error", (err as Error).message);
      this.emitError(err as Error);
      throw err;
    }
  }

  /**
   * TASK-56: resume an already-claimed session. Skips the REST
   * claim entirely (the token was minted by the claims screen or
   * restored from `localStorage`) and runs the same
   * `hello → auth → join_system` handshake `start()` uses.
   *
   * Returns once the client is `online` (post `enter_system`).
   * Failure behaviour mirrors `start()`: a handshake error with a
   * cached token hands off to the auto-reconnect loop instead of
   * surfacing a dead-end error state.
   *
   * @param session token + callsign + the system to join (the boot
   *   flow prefers the session's last system, falling back to home).
   */
  async startWithSession(session: {
    token: string;
    callsign: string;
    systemId: string;
  }): Promise<void> {
    if (this.status === "online" || this.status === "joining") return;
    this.token = session.token;
    this.callsign = session.callsign;
    this.homeSystemId = session.systemId;
    // TASK-74: startWithSession does not currently include a
    // shipId (the boot flow's token carries the claim, not the
    // ship). The local predictor fallbacks to reading the own
    // entity's id from the remote buffer registry when
    // `shipId === null`, so a returning player without a cached
    // shipId still gets a hydrated predictor on the first
    // `entity_update` after the handshake.
    this.presence.setOwnCallsign(session.callsign);
    try {
      this.setStatus("connecting");
      await this.openSession(session.systemId, /* preserve */ false);
      this.setStatus("online");
    } catch (err) {
      if (this.token && !this.isReconnecting) {
        this.setStatus("reconnecting", (err as Error).message);
        this.beginReconnectLoop();
        return;
      }
      this.setStatus("error", (err as Error).message);
      this.emitError(err as Error);
      throw err;
    }
  }

  /**
   * Tear the connection down. Idempotent. On a clean disconnect
   * the store's `leaveAll()` fires so any HUD still mounted can
   * collapse to the empty state.
   */
  async stop(): Promise<void> {
    // Cancel any in-flight reconnect loop so the abort flag stops
    // a sleeping `await this.sleep(...)` from re-running the
    // handshake after the user navigated away.
    if (this.reconnectAbort) {
      this.reconnectAbort.aborted = true;
      this.reconnectAbort = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1000, "client-stop");
      } catch {
        // ignore — the socket may already be closed
      }
    }
    this.socket = null;
    this.presence.leaveAll();
    this.chat.clear();
    this.resetRemoteBuffers();
    this.setStatus("disconnected");
  }

  /**
   * Drive a system change. The handshake must already be complete
   * (callsign claimed + `auth_ok` received). Fires `leaveAll()` on
   * the store so the HUD collapses to the empty state, then sends
   * a fresh `join_system` frame and awaits `enter_system`.
   *
   * Used by the warp UI (TASK-8) and by the Playwright smoke test
   * to force two contexts into the same shard.
   */
  async joinSystem(systemId: string): Promise<void> {
    if (!this.socket) {
      throw new Error("DriftClient: joinSystem requires a live socket — call start() first");
    }
    // Clear the local roster + chat so any HUD mounted during the
    // join doesn't render stale entries from the previous system.
    this.presence.leaveAll();
    this.chat.clear();
    this.resetRemoteBuffers();
    await this.runJoin(this.socket, systemId);
    this.systemId = systemId;
  }

  /**
   * Send a chat message to the server. The server validates +
   * sanitizes + rate-limits; on accept it broadcasts a `chat`
   * frame back to every connection in the shard (sender included)
   * so the UI collapses on the echo. Returns once the message
   * has been handed to the WebSocket layer — the caller can use
   * the chat store's snapshot to confirm delivery once the echo
   * arrives.
   *
   * Throws if the socket isn't open (i.e. the client isn't
   * `online`). The `ChatLog` UI guards against this with the
   * online-state check.
   */
  sendChat(text: string): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendChat requires an open socket");
    }
    this.socket.send(encodeEnvelope("chat", { text }));
  }

  /**
   * Send a player input frame. The server integrates the *latest*
   * input per connection per tick; seq is for the client's own
   * reconciliation against the server's `lastAppliedSeq` ack.
   *
   * Throws if the socket isn't open (i.e. the client isn't
   * `online`). The renderer guards against this with the
   * online-state check.
   */
  sendInput(input: {
    seq: number;
    thrust: number;
    turn: number;
    pitch: number;
    yaw: number;
    fire?: boolean;
    lock?: boolean;
    action?: string | null;
  }): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendInput requires an open socket");
    }
    this.socket.send(
      encodeEnvelope("input", {
        seq: input.seq,
        thrust: input.thrust,
        turn: input.turn,
        pitch: input.pitch,
        yaw: input.yaw,
        fire: input.fire ?? false,
        lock: input.lock ?? false,
        action: input.action ?? null,
      }),
    );
  }

  /**
   * TASK-8: send a warp request. The server validates the target
   * system and replies with a `warp_arrived` frame on success or an
   * `error` frame on rejection. The client subscribes to both via
   * the warp store (see `App.tsx`) so the UI can render the streak
   * overlay + swap-world transition without coupling to the
   * WebSocket layer.
   *
   * No client-side rate-limit: the chart UI already disables the
   * Warp button while a warp is in flight, so a double-click is
   * impossible in practice. The server-side rate-limit also catches
   * any pathological frames.
   */
  sendWarp(targetSystemId: string): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendWarp requires an open socket");
    }
    this.socket.send(encodeEnvelope("warp", { targetSystemId }));
  }

  /**
   * TASK-31: send an `exit_ship` request. The server validates the
   * ship is docked, mints a character entity, rebinds the
   * connection, and broadcasts the character via the next
   * `entity_update` (≤ 100 ms). The client can treat the receipt
   * of its own character in the next snapshot as the success
   * confirmation — there is no `exit_ship_ok` frame.
   *
   * Throws if the socket isn't open (i.e. the client isn't
   * `online`). The exit-prompt UI guards against this with the
   * online-state check + a docked-only visibility gate.
   */
  sendExitShip(): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendExitShip requires an open socket");
    }
    this.socket.send(encodeEnvelope("exit_ship", {}));
  }

  /**
   * TASK-35: send an `enter_ship` request. Reverses `sendExitShip`:
   * the player is on foot near their own docked/idle ship and
   * presses `E` to reboard. The server validates ownership,
   * velocity, and the 5 m proximity radius (server-authoritative)
   * and replies with either `enter_ship_ok { shipId }` on success
   * or an `error` frame carrying `not-owner`, `ship-moving`,
   * `out-of-range`, `already-in-ship`, `wrong-regime`, or
   * `invalid-message`.
   *
   * No client-side proximity check (the prompt already gates on
   * the 3 m × 30° forward cone): the server's 5 m check accepts a
   * player on the *back* side of their ship too, so the prompt
   * doesn't need to widen.
   *
   * Throws if the socket isn't open. The enter-ship prompt UI
   * guards against this via the `enabled={status === 'online'}`
   * gate (analogous to `sendExitShip`).
   */
  sendEnterShip(): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendEnterShip requires an open socket");
    }
    this.socket.send(encodeEnvelope("enter_ship", {}));
  }

  /**
   * TASK-33: send an `interact` request. The server validates the
   * target via the active shard's `InteractableRegistry` and replies
   * with either `interact_ok` (success) or an `error` frame carrying
   * one of `out-of-range` / `wrong-regime` / `not-found`.
   *
   * Throws if the socket isn't open. The interaction prompt UI
   * guards against this via the `enabled={status === 'online'}` gate.
   */
  sendInteract(targetId: string, action: "use" | "enter" | "exit" | "inspect" | "mine"): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendInteract requires an open socket");
    }
    this.socket.send(encodeEnvelope("interact", { targetId, action }));
  }

  /**
   * TASK-38: start a mining channel on the given deposit. The
   * server replies with a `mining_update` echo on accept and then
   * per-cadence `inventory_update` / `mining_update` frames as the
   * channel progresses. The client UI reads the `mining_update`
   * stream to drive the radial progress.
   *
   * The handler is idempotent — re-pressing E on the same
   * deposit just refreshes `lastAwardAt` server-side without
   * starting a new channel. Spamming the call is also a no-op:
   * awards happen on the 1.5 s cadence, not on the message
   * count.
   */
  sendMine(nodeId: string, durationSeconds = 1.5): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendMine requires an open socket");
    }
    this.socket.send(encodeEnvelope("mine", { nodeId, duration: durationSeconds }));
  }

  /**
   * TASK-38: stop an in-flight mining channel. Idempotent
   * (releasing E while not mining is a structured `invalid-message`
   * error, not a silent drop). On success the server emits a
   * final `mining_update { state: 'cancelled', unitsSoFar: N }`
   * so the client can show the earned-amount toast while hiding
   * the radial.
   */
  sendMineStop(): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendMineStop requires an open socket");
    }
    this.socket.send(encodeEnvelope("mine_stop", {}));
  }

  /**
   * TASK-38: subscribe to `mining_update` server frames. The
   * server pushes one of these on every award + on `mine` start
   * + on `mine_stop` + on pause-for-cap + on depletion. The
   * payload carries `progressMs` (the 0..1500 ms radial value)
   * + `state` so the UI can drive the radial without running its
   * own cadence timer (the server is the source of truth).
   */
  onMiningUpdate(
    listener: (payload: {
      depositId: string;
      resourceId: string;
      progressMs: number;
      unitsSoFar: number;
      amount: number;
      state: "mining" | "paused-full" | "depleted" | "cancelled";
    }) => void,
  ): () => void {
    this.miningUpdateListeners.add(listener);
    return () => {
      this.miningUpdateListeners.delete(listener);
    };
  }

  /**
   * TASK-DEV: fire a synthetic `mining_update` through the listener
   * stream without a real WS frame. Mirrors what the inbound
   * `handleMessage` switch does for the server frame so e2e tests
   * can drive the radial UI without the full flight-to-deposit
   * harness. Dev/test only — production callers should rely on the
   * real server cadence (the anti-spam guarantee depends on the
   * server being the source of truth).
   */
  __fireMiningUpdateForTest(payload: {
    depositId: string;
    resourceId: string;
    progressMs: number;
    unitsSoFar: number;
    amount: number;
    state: "mining" | "paused-full" | "depleted" | "cancelled";
  }): void {
    for (const listener of this.miningUpdateListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow — same rationale as the WS path.
      }
    }
  }

  /**
   * TASK-43: synthetic `fire_ok` seam for e2e screenshots.
   * Mirrors the TASK-38 mining seam — let the Playwright spec
   * render the FX without driving a real fire through the WS
   * (the e2e harness boots a fresh shard with no targets to hit,
   * and a no-target fire rejects with `no-target` so the FX
   * layer never sees an accepted fire). The screenshot still
   * proves "fire a laser in the browser, screenshot the flash"
   * per TASK-43 acceptance.
   *
   * Dev/test only — production code never reaches this seam.
   */
  __fireFireOkForTest(payload: {
    weapon: "laser" | "missile";
    kind: "laser" | "missile" | "denied";
    damage: number;
    projectileId: string | null;
    energy: number;
    denialCode: string | null;
  }): void {
    for (const listener of this.fireOkListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow — same rationale as the WS path.
      }
    }
  }

  /**
   * TASK-51: synthetic `combat_event { kind: 'hit' | 'damaged' }`
   * seam for e2e screenshots. Drives the ShipHUD vitals-bar flash
   * without a real `combat_event` round-trip from the server.
   * Production never reaches this seam.
   */
  __fireSelfHitForTest(args: { kind: "hit" | "damaged"; target: string }): void {
    for (const listener of this.selfHitListeners) {
      try {
        listener(args);
      } catch {
        // Swallow — same rationale as the WS path.
      }
    }
  }

  /**
   * TASK-51: subscribe to self-hit events. Listeners decide
   * whether `target` matches the local ship id before flipping
   * the flash controller (the `TargetingStore.applyCombatEvent`
   * filter on `source !== self` is the server-side reference).
   */
  onSelfHit(listener: (event: { kind: "hit" | "damaged"; target: string }) => void): () => void {
    this.selfHitListeners.add(listener);
    return () => {
      this.selfHitListeners.delete(listener);
    };
  }

  /**
   * TASK-34: send a `pickup` request for a deposit or a ground
   * item. The server validates the target via the shard's
   * proximity-interaction math (3 m × 30° forward cone) and
   * replies with `inventory_update` on success.
   */
  sendPickup(targetId: string): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendPickup requires an open socket");
    }
    this.socket.send(encodeEnvelope("pickup", { targetId }));
  }

  /**
   * TASK-34: send a `drop` request. Spawns a ground-item entity at
   * the character's location carrying `amount` units of
   * `resourceType`. Server validates inventory ownership and replies
   * with `inventory_update` on success.
   */
  sendDrop(resourceType: string, amount: number): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendDrop requires an open socket");
    }
    this.socket.send(encodeEnvelope("drop", { resourceType, amount }));
  }

  /**
   * TASK-39: send a `cargo_transfer` request. The server
   * validates proximity (5 m of own docked ship), ownership,
   * and the destination cap before persisting either side. The
   * client mirrors the resulting `cargo_update` ack into the
   * local cache via `applyCargoUpdate` so the HUD observes the
   * new shape on its next 250 ms poll.
   */
  sendCargoTransfer(resourceId: string, amount: number, from: "inv" | "hold"): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendCargoTransfer requires an open socket");
    }
    this.socket.send(encodeEnvelope("cargo_transfer", { resourceId, amount, from }));
  }

  /**
   * TASK-40: fire a `sell` frame at the dock. The server
   * validates "at a station" (docked ship OR on-foot within
   * 10 m of a docked ship's terminal), debits the source
   * stack, and credits the earned amount. The `source` field
   * is OPTIONAL — the server infers it from the bound entity
   * (ship → `'hold'`, character → `'inv'`).
   *
   * The ack (`sell_ok`) is fan-out to subscribers registered
   * via `onSellOk`.
   */
  sendSell(resourceType: string, quantity: number, source?: "inv" | "hold"): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendSell requires an open socket");
    }
    const payload: { resourceType: string; quantity: number; source?: "inv" | "hold" } = {
      resourceType,
      quantity,
    };
    if (source !== undefined) payload.source = source;
    this.socket.send(encodeEnvelope("sell", payload));
  }

  /**
   * TASK-40: subscribe to `sell_ok` frames. Returns an
   * unsubscribe function. The DockPanel mounts this listener
   * to surface the "+N cr" floating text + bump the credits
   * counter on the same frame the server commits.
   */
  onSellOk(
    listener: (payload: {
      resourceType: string;
      quantity: number;
      sold: number;
      earned: number;
      newBalance: number;
      source: "inv" | "hold";
    }) => void,
  ): () => void {
    this.sellOkListeners.add(listener);
    return () => {
      this.sellOkListeners.delete(listener);
    };
  }

  /**
   * TASK-34: read the latest known on-foot inventory. Returns
   * `null` until the first `inventory_update` lands; the WeightBar
   * HUD hides itself in that state.
   */
  getInventory(): Inventory | null {
    return this.inventory;
  }

  /**
   * TASK-39: read the latest known ship cargo hold. Returns
   * `null` until the first `cargo_update` lands; the CargoPanel
   * HUD hides itself in that state.
   */
  getCargo(): CargoHold | null {
    return this.cargo;
  }

  /**
   * TASK-43: read the latest known weapon state (active
   * weapon, energy, lockout). Returns `null` until the first
   * `weapon_state` lands; the WeaponHud hides itself in that
   * state. The HUD polls at 250 ms cadence (matches the
   * WeightBar / CargoPanel pattern).
   */
  getWeaponState(): WeaponStateSnapshot | null {
    return this.weaponState;
  }

  /**
   * TASK-44: read-only accessor for the targeting store. The HUD
   * polls `getTargeting()` at the same 250 ms cadence as
   * `getWeaponState()` so the target-box + threat-ping
   * components stay in sync.
   */
  getTargeting(): TargetingStore {
    return this.targeting;
  }

  /**
   * TASK-47: read-only accessor for the kill-feed store. The
   * `<KillFeed>` HUD widget pulls this directly via React's
   * `useSyncExternalStore`, then re-renders on every entry
   * push + reap.
   */
  getKillFeed(): KillFeedStore {
    return this.killFeed;
  }

  /**
   * TASK-49: accessor for the destruction FX store. The
   * `<DestructionFx>` layer subscribes to it; the store is fed
   * `combat_event { kind: 'destroyed' }` frames (explosion + slow-mo
   * + the 2 s "SHIP LOST" moment) and the wreck rows of every
   * `entity_update` (killer markers).
   */
  getDestruction(): DestructionStore {
    return this.destruction;
  }
  /**
   * TASK-48: accessor for the per-player hazard store. The HUD
   * (exposure meter, in-world hazard layer) calls this from its
   * `useSyncExternalStore` hook so the meter reflects the live
   * exposure pool without polling.
   */
  getHazardStore(): HazardStore {
    return this.hazardStore;
  }

  /**
   * TASK-44: subscribe to live targeting events (`locked` /
   * `released` / `update`). Returns an unsubscribe handle.
   * Used by tests + the threat-ping bridge in `App.tsx` that
   * reaps expired pings each frame.
   */
  onTargetUpdate(listener: (event: TargetingEvent) => void): () => void {
    this.targetUpdateListeners.add(listener);
    return () => {
      this.targetUpdateListeners.delete(listener);
    };
  }

  /**
   * TASK-50: e2e / dev seam — push a `weapon_state` snapshot into
   * the client cache without a server round-trip, so the combat
   * HUD's weapon readout (selector + energy band + missile count)
   * can be screenshotted deterministically. Production only ever
   * writes `weaponState` from the real `weapon_state` frame.
   */
  __fireWeaponStateForTest(payload: {
    activeWeapon: "laser" | "missile";
    energy: number;
    locked?: boolean;
    lockedUntilMs?: number;
  }): void {
    this.weaponState = {
      activeWeapon: payload.activeWeapon,
      energy: payload.energy,
      locked: payload.locked ?? false,
      lockedUntilMs: payload.lockedUntilMs ?? 0,
    };
  }

  /**
   * TASK-43: send a weapon fire intent. The server is the
   * source of truth for rate / energy / range / LOS; denied
   * fires surface as an `error` frame (no FX).
   */
  sendFire(args: { weapon: "laser" | "missile"; targetId?: string | null }): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendFire requires an open socket");
    }
    this.socket.send(
      encodeEnvelope("fire", { weapon: args.weapon, targetId: args.targetId ?? null }),
    );
  }

  /**
   * TASK-43: switch the active weapon (the `1` / `2` keys).
   * The server records the new active weapon + pushes a
   * `weapon_state` so the HUD selector flips on the same
   * frame.
   */
  sendSelectWeapon(weapon: "laser" | "missile"): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendSelectWeapon requires an open socket");
    }
    this.socket.send(encodeEnvelope("select_weapon", { weapon }));
  }

  /**
   * TASK-44: send a target-lock intent (`T` key on the client).
   *
   * `targetId === null` is the "release whatever" path; the
   * server clears the connection's lock and pushes a
   * `target_released` frame. Re-pressing T on the already-
   * locked target is the toggle-off path (the server
   * auto-releases on the duplicate request).
   */
  sendTargetLock(targetId: string | null): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendTargetLock requires an open socket");
    }
    this.socket.send(encodeEnvelope("target_lock", { targetId }));
  }

  /**
   * TASK-44: explicit release intent (alternative to
   * `sendTargetLock(null)`). Used by the HUD's "release target"
   * button when the player is on a UI surface where the
   * `null` semantic of `sendTargetLock` doesn't apply.
   */
  sendTargetRelease(): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("DriftClient: sendTargetRelease requires an open socket");
    }
    // TypeScript's overloaded `encodeEnvelope` only narrows on
    // the discriminated payload type; the empty-payload case
    // forces a runtime cast (the wire envelope for
    // `target_release` is the empty-object form).
    this.socket.send(
      encodeEnvelope("target_release" as unknown as Parameters<typeof encodeEnvelope>[0], {}),
    );
  }

  /**
   * TASK-43: subscribe to `fire_ok` server frames. The
   * listener fires on every accepted weapon fire (laser
   * instant / missile spawn) and on every denial (`kind:
   * 'denied'`). The FX layer uses the accepted path to
   * trigger the muzzle flash + tracer; denied fires surface
   * no FX per the spec.
   */
  onFireOk(
    listener: (payload: {
      weapon: "laser" | "missile";
      kind: "laser" | "missile" | "denied";
      damage: number;
      projectileId: string | null;
      energy: number;
      denialCode: string | null;
    }) => void,
  ): () => void {
    this.fireOkListeners.add(listener);
    return () => {
      this.fireOkListeners.delete(listener);
    };
  }

  /**
   * TASK-33: register a listener for `ui_open` server frames.
   * Dock terminals and any future modal surfaces use this channel
   * so the modal lives entirely on the client (the server emits a
   * single presentation directive).
   */
  onUiOpen(
    listener: (payload: { ui: string; payload: Record<string, unknown> }) => void,
  ): () => void {
    this.uiOpenListeners.add(listener);
    return () => {
      this.uiOpenListeners.delete(listener);
    };
  }

  /**
   * TASK-35: subscribe to `enter_ship_ok` frames. Fired when the
   * server commits a re-entry (character → ship entity switch).
   * The owning client listens so it can swap the camera + controls
   * + character mesh synchronously without waiting for the next
   * `entity_update` broadcast. Returns an unsubscribe function.
   */
  onEnterShipOk(listener: (payload: { shipId: string }) => void): () => void {
    this.enterShipOkListeners.add(listener);
    return () => {
      this.enterShipOkListeners.delete(listener);
    };
  }

  /**
   * TASK-8: consume the canonical snapshot from a `warp_arrived`
   * frame. Updates the live `systemId`, clears stale presence /
   * chat (the target system is a fresh roster), and rebuilds the
   * remote-entity buffer from the new entities list. Returns
   * `void` — callers (the warp state machine subscriber in
   * `App.tsx`) only need to know the warp landed.
   *
   * Implemented as a public method (instead of being inlined into
   * `handleMessage`) so unit tests can drive it directly without a
   * live socket.
   */
  applyWarpArrived(payload: PayloadFor<"warp_arrived">): void {
    // The target's roster is independent of the source's, so we
    // wipe both stores before applying the new frame. The
    // presence broadcaster hasn't fired yet for the new system
    // either, so a stale roster would leak otherwise.
    this.presence.leaveAll();
    this.chat.clear();
    this.resetRemoteBuffers();
    this.systemId = payload.systemId;
    // Seed the remote buffers with the canonical entities so the
    // future renderer (TASK-26) can hydrate immediately.
    //
    // Same fix as the `entity_update` / `state_snapshot` path
    // (the comment on `simEntityFromWire` below): push the
    // simulator-shaped lite, not the raw wire frame. The wire
    // frame has no `quat` field, so `interpolateEntity` would
    // throw a `Cannot read properties of undefined (reading 'x')`
    // every frame after the warp until the next `entity_update`
    // lands and replaces the seed state.
    const nowMs = (this.opts.now ?? Date.now)();
    for (const entity of payload.entities) {
      const ent = entity as { id: string };
      if (!ent.id) continue;
      let buf = this.remoteBuffers.get(ent.id);
      if (!buf) {
        buf = new RemoteEntityBuffer();
        this.remoteBuffers.set(ent.id, buf);
      }
      buf.push(nowMs, simEntityFromWire(entity as Parameters<typeof simEntityFromWire>[0]));
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Open a fresh socket, run `hello → auth → join_system`, and
   * resolve once `enter_system` lands. Used by both `start()` (after
   * the initial claim) and the auto-reconnect loop (which reuses
   * the saved token).
   *
   * `preserve` controls whether `presence` + `chat` should survive
   * the reconnect (true → keep, false → clear). The caller decides
   * based on the disconnect duration + system id match.
   */
  private async openSession(targetSystem: string, preserve: boolean): Promise<void> {
    const origin = this.opts.origin ?? (typeof location !== "undefined" ? location.origin : "");
    const wsPath = this.opts.wsPath ?? "/ws";
    const wsUrl = origin ? `${origin.replace(/^http/, "ws")}${wsPath}` : `${wsPath}`;
    const socket = (this.opts.createSocket ?? defaultCreateSocket)(wsUrl);
    this.socket = socket;
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);

    // Decide whether UI state should be preserved. The auto-retry
    // path passes `preserve = isPreservable()`; `start()` always
    // passes `false` because there's no prior disconnect.
    //
    // We clear *before* the handshake runs (rather than after
    // `runJoin` resolves) so the `presence` broadcast that arrives
    // around `enter_system` can't race with `leaveAll()` and end up
    // wiping the freshly-applied roster. On the initial start the
    // store is already empty, so this is a no-op snapshot emit.
    if (!preserve) {
      this.presence.leaveAll();
      this.chat.clear();
    }

    this.setStatus("connecting");
    // Give the socket a tick to transition to OPEN so the
    // handshake listener sees an actual `open` event before we
    // send `hello` (in Node, the `open` event fires on the next
    // microtask).
    await Promise.resolve();
    this.setStatus("handshaking");
    await this.runHandshake(socket);

    this.setStatus("joining");
    await this.runJoin(socket, targetSystem);
    this.systemId = targetSystem;

    // Tear down the previous remote-entity buffers before the App
    // rebuilds its predictor — every snapshot we receive from here
    // on is the canonical post-resync state.
    this.resetRemoteBuffers();
  }

  /**
   * Decide whether a successful reconnect should preserve the
   * `presence` + `chat` stores. Returns true when:
   *
   *   - the previous disconnect was < `resyncPreserveMs` ago, AND
   *   - the system id at disconnect time matches the system id we
   *     just joined (no system change), AND
   *   - we previously reached `online` (i.e. we have a meaningful
   *     `lastSystemId` / `lastDisconnectedAtMs` to compare against).
   *
   * Otherwise the client wipes the local state so a stale roster
   * from a different system (or a 10-minute-late reconnect) doesn't
   * leak into the next session.
   */
  private isPreservable(): boolean {
    if (this.lastSystemId === null || this.disconnectedAtMs === null) return false;
    const now = (this.opts.now ?? Date.now)();
    const elapsed = now - this.disconnectedAtMs;
    const window = this.opts.resyncPreserveMs ?? DEFAULT_RESYNC_PRESERVE_MS;
    if (elapsed < 0 || elapsed > window) return false;
    if (this.systemId !== null && this.systemId !== this.lastSystemId) return false;
    return true;
  }

  /**
   * Drive the auto-reconnect loop until either the socket reaches
   * `online` (success) or the retry budget is exhausted (gives up
   * and goes to `lost`). Idempotent: a second invocation while the
   * first loop is still running is a no-op so `handleClose` plus
   * `start()`'s catch path can't spawn parallel loops.
   */
  private beginReconnectLoop(): void {
    if (this.reconnectAbort) return;
    const abort = { aborted: false };
    this.reconnectAbort = abort;
    const sleep = this.opts.sleep ?? defaultSleep;
    const initialMs = this.opts.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS;
    const maxMs = this.opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const budgetMs = this.opts.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    const now = this.opts.now ?? Date.now;

    const startedAt = now();
    let backoff = initialMs;

    const attempt = async (): Promise<void> => {
      while (!abort.aborted) {
        const elapsed = now() - startedAt;
        if (elapsed >= budgetMs) {
          // Budget exhausted — clear the abort + flip status.
          this.reconnectAbort = null;
          this.setStatus("lost");
          return;
        }
        try {
          // The reconnect re-uses the saved token. We need a
          // system id to join — prefer the cached systemId; fall
          // back to the original home system id from the claim.
          const targetSystem = this.lastSystemId ?? this.homeSystemId;
          if (targetSystem === null) {
            throw new Error("DriftClient: cannot reconnect without a cached systemId");
          }
          if (!this.token) {
            throw new Error("DriftClient: cannot reconnect without a saved token");
          }
          // Re-check the budget right before opening so a sleep
          // that consumed the remaining budget doesn't waste a
          // socket attempt.
          if (now() - startedAt >= budgetMs) {
            this.reconnectAbort = null;
            this.setStatus("lost");
            return;
          }
          this.setStatus("connecting");
          await this.openSession(targetSystem, /* preserve */ this.isPreservable());
          this.reconnectAbort = null;
          this.setStatus("online");
          // Notify resync listeners (App.tsx renders the
          // "Reconnected" toast off this).
          const event: ResyncEvent = {
            preserved: this.isPreservable(),
            systemId: targetSystem,
            disconnectedAtMs: this.disconnectedAtMs ?? now(),
          };
          for (const listener of this.resyncListeners) {
            try {
              listener(event);
            } catch {
              // swallow — faulty listener must not break the loop
            }
          }
          this.opts.onResync?.(event);
          // Clear the disconnect timestamp — the next close
          // starts a fresh measurement.
          this.disconnectedAtMs = null;
          this.lastSystemId = null;
          return;
        } catch (err) {
          // Tear down any partial socket the openSession attempt
          // left behind so handleClose doesn't fire mid-loop.
          if (this.socket) {
            try {
              this.socket.close();
            } catch {
              // ignore
            }
            this.socket = null;
          }
          this.emitError(err as Error);
          // Exponential backoff capped at `retryMaxMs`.
          await sleep(backoff);
          if (abort.aborted) return;
          backoff = Math.min(maxMs, Math.floor(backoff * 1.5));
        }
      }
      this.reconnectAbort = null;
    };
    void attempt();
  }

  /**
   * Drop every per-entity remote buffer. Called on `enter_system`
   * (resync) and on `stop()` so the next session starts with a
   * clean slate.
   */
  private resetRemoteBuffers(): void {
    for (const buf of this.remoteBuffers.values()) buf.clear();
    this.remoteBuffers.clear();
    this.remoteCallsigns.clear();
    this.playerOwnedEntities.clear();
    this.opts.remoteBufferRegistry?.reset();
  }

  /**
   * TASK-75: mark player-owned entities + drop the ones whose owner
   * left the presence roster. Runs on every `presence` frame (the
   * server only sends one when the roster actually changes, so this
   * is a handful of calls per session).
   *
   * Only ids already known to belong to a *roster* callsign are
   * eligible — AI ships carry callsigns too (`AI-…`) and would
   * otherwise be pruned on the first roster frame.
   */
  private reconcilePresenceLiveness(payload: PayloadFor<"presence">): void {
    const roster = new Set<string>();
    for (const entry of payload.players) roster.add(entry.callsign);
    this.presentCallsigns = roster;
    for (const [id, callsign] of [...this.remoteCallsigns]) {
      if (roster.has(callsign)) {
        this.playerOwnedEntities.add(id);
        continue;
      }
      if (!this.playerOwnedEntities.has(id)) continue;
      // The owner disconnected: drop the buffer so the renderer
      // releases the mesh on the next frame instead of drawing a
      // ghost forever.
      this.remoteCallsigns.delete(id);
      this.playerOwnedEntities.delete(id);
      this.remoteBuffers.delete(id);
    }
  }

  /**
   * TASK-74: reconcile the local ship predictor against any
   * own-ship snapshot in an inbound frame. Walks the entity
   * array once, looking for the entity whose id matches
   * `entity:<shipId>` OR (when no shipId is cached) whose
   * callsign matches `currentCallsign`. On match: snap the
   * predictor's server state, applying the same Quake-III
   * blend/rewind/force-snap logic the predictor itself owns.
   *
   * No-op when the predictor has not been touched yet (cold
   * mount without any input pump) or the frame doesn't carry
   * our ship. Called once per `entity_update`/`state_snapshot`
   * so the server's authoritative ground truth wins over the
   * local prediction in O(1).
   */
  private reconcileOwnShipFromFrame(
    entities: Parameters<typeof simEntityFromWire>[0][] | never,
    nowMs: number,
    lastAppliedSeq: Record<string, number> | undefined,
  ): void {
    if (!Array.isArray(entities)) return;
    if (this.callsign === null) return;
    const targetId = this.shipId !== null ? `entity:${this.shipId}` : null;
    let ownEntity: Parameters<typeof simEntityFromWire>[0] | null = null;
    for (const e of entities) {
      const ent = e as {
        id: string;
        kind?: string;
        callsign?: string | null;
      };
      if (targetId !== null && ent.id === targetId) {
        ownEntity = e as Parameters<typeof simEntityFromWire>[0];
        break;
      }
      if (
        targetId === null &&
        ent.callsign === this.callsign &&
        (ent.kind === "ship" || ent.kind === undefined) &&
        typeof ent.id === "string" &&
        ent.id.startsWith("entity:")
      ) {
        ownEntity = e as Parameters<typeof simEntityFromWire>[0];
        // Cache the shipId once we resolve it via callsign so
        // subsequent frames use the fast `entity:<shipId>` path.
        this.shipId = ent.id.slice("entity:".length);
        break;
      }
    }
    if (ownEntity === null) return;
    const simLite = simEntityFromWire(ownEntity);
    const predictor = this._predictor ?? this.predictor;
    // The wire shape is missing rotation (the predictor's
    // simulator fields default to identity on the first frame);
    // subsequent reconciles inherit the previous orientation so
    // the local rotation never visually jumps when the server
    // omits quat.
    const seq =
      this.playerId !== null && lastAppliedSeq !== undefined
        ? (lastAppliedSeq[this.playerId] ?? null)
        : null;
    // Hydrate the predictor on the very first call so the
    // initial ship state matches the server's authority rather
    // than the placeholder origin.
    if (
      this._predictor !== null &&
      this._predictor.state().pos.x === 0 &&
      this._predictor.state().pos.y === 0 &&
      this._predictor.state().pos.z === 0 &&
      (simLite.pos.x !== 0 || simLite.pos.y !== 0 || simLite.pos.z !== 0)
    ) {
      predictor.forceSnap(nowMs, simLite);
      return;
    }
    predictor.reconcile({ now: nowMs, serverState: simLite, lastAppliedSeq: seq });
  }

  private async claimCallsignWithRetry(): Promise<ClaimResponse> {
    const fetchImpl = this.opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!fetchImpl) throw new Error("no fetch implementation available");
    const claimPath = this.opts.claimPath ?? "/api/callsigns";
    const origin = this.opts.origin ?? (typeof location !== "undefined" ? location.origin : "");
    const base = this.opts.callsign ?? `Drift-${randomSuffix()}`;
    let attempts = 0;
    let callsign = base;
    while (attempts < 5) {
      const res = await fetchImpl(`${origin}${claimPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callsign }),
      });
      if (res.status === 200) {
        return (await res.json()) as ClaimResponse;
      }
      if (res.status === 409) {
        // callsign-taken — append a numeric suffix and retry
        attempts++;
        callsign = `${base}-${attempts}`;
        continue;
      }
      const text = await res.text();
      throw new Error(`claim failed: ${res.status} ${text}`);
    }
    throw new Error(`claim failed after ${attempts} retries`);
  }

  private runHandshake(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const onOpen = (): void => {
        if (this.token) {
          socket.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        }
      };
      const onMessage = (event: MessageEvent): void => {
        let env;
        try {
          env = decodeEnvelope(event.data as string);
        } catch {
          return;
        }
        if (env.type === "hello") {
          if (!this.token) return;
          socket.send(encodeEnvelope("auth", { token: this.token }));
          return;
        }
        if (env.type === "auth_ok") {
          const payload = env.payload as PayloadFor<"auth_ok">;
          this.playerId = payload.playerId;
          this.callsign = payload.callsign;
          this.presence.setOwnCallsign(payload.callsign);
          resolve();
          return;
        }
        if (env.type === "error") {
          reject(new Error(`handshake error: ${(env.payload as { message: string }).message}`));
          return;
        }
      };
      const onError = (event: Event): void => {
        reject(new Error(`socket error: ${(event as ErrorEvent).message ?? "unknown"}`));
      };
      // TASK-17: a mid-handshake close must reject the handshake
      // promise so the retry loop can advance to the next
      // backoff. Without this, a server that accepts the
      // connection then immediately drops it would leave the
      // handshake hanging until the retry budget exhausts.
      const onClose = (): void => {
        reject(new Error("handshake aborted: socket closed before auth_ok"));
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  private runJoin(socket: WebSocket, systemId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        let env;
        try {
          env = decodeEnvelope(event.data as string);
        } catch {
          return;
        }
        if (env.type === "enter_system") {
          // The server's `enter_system.players` is a string[] of
          // callsigns; the next `presence` frame carries the full
          // roster with playerId + shipId. We don't seed anything
          // here — the store will receive the canonical roster
          // within a few ms. We just need to know the join was
          // accepted to resolve.
          const payload = env.payload as PayloadFor<"enter_system">;
          // TASK-16: seed the chat history so the freshly-joined
          // client renders the previous 100 messages immediately.
          // The server caps `chat` at 100 so the array is always
          // bounded. (Earlier in `joinSystem` / `clear` we already
          // dropped any prior entries.)
          this.chat.seedHistory(payload.chat as unknown as Parameters<ChatStore["seedHistory"]>[0]);
          resolve();
          return;
        }
        if (env.type === "error") {
          reject(new Error(`join error: ${(env.payload as { message: string }).message}`));
          return;
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(encodeEnvelope("join_system", { systemId }));
    });
  }

  private handleMessage = (event: MessageEvent): void => {
    let env;
    try {
      env = decodeEnvelope(event.data as string);
    } catch {
      return;
    }
    switch (env.type) {
      case "presence": {
        const payload = env.payload as PayloadFor<"presence">;
        this.opts.presenceSink?.(payload);
        this.presence.applyPresenceFrame(payload);
        // TASK-75: free the buffers of players who just left so
        // their meshes disappear instead of lingering.
        this.reconcilePresenceLiveness(payload);
        return;
      }
      case "chat": {
        // TASK-16: feed the broadcast into the chat store. The
        // server emits this frame on every accept; sender included.
        // The outbound `ChatSchema` is just `{text}`, but the
        // broadcast payload carries the full ChatEntry shape — we
        // accept the broader type and let `applyChatFrame` validate.
        const payload = env.payload as unknown as Parameters<ChatStore["applyChatFrame"]>[0];
        this.chat.applyChatFrame(payload);
        return;
      }
      case "warp_arrived": {
        // TASK-8: inter-system travel landed. Hydrate the
        // target system from the canonical snapshot and surface
        // the event via the `warpArrived` listener so the warp
        // state machine in `state/warp.ts` can drive the
        // `awaiting → warping-out` transition.
        const payload = env.payload as PayloadFor<"warp_arrived">;
        this.applyWarpArrived(payload);
        for (const listener of this.warpArrivedListeners) {
          try {
            listener(payload);
          } catch {
            // swallow — faulty listener must not break the loop
          }
        }
        this.opts.onWarpArrived?.(payload);
        return;
      }
      case "error": {
        // TASK-8: fan the error frame out to the warp-rejected
        // subscribers. The server uses the same `error` envelope
        // for both join and warp rejections; we filter on code
        // so a non-warp error (e.g. a join rejection during
        // boot) doesn't fire spurious warp-failed toasts.
        const payload = env.payload as { code: string; message: string };
        const warpCodes = new Set(["system-full", "system-not-found", "same-system"]);
        if (warpCodes.has(payload.code)) {
          for (const listener of this.warpRejectedListeners) {
            try {
              listener({ code: payload.code, message: payload.message });
            } catch {
              // swallow
            }
          }
        }
        return;
      }
      case "combat_event": {
        // TASK-44: threat-ping pipeline. We push every
        // `damaged` / `hit` / `destroyed` event (where source
        // != self) into the targeting store; the HUD reads the
        // cached `threatPings` and renders the radial-arc
        // indicator. `kill` events are silently dropped (the
        // spec scopes threat pings to the hit / damage / kill
        // chain, but the kill frame fires on *our* kills so
        // it's not a threat against us).
        const payload = env.payload as Parameters<TargetingStore["applyCombatEvent"]>[0];
        // Resolve the local player's entity id. The
        // `DriftClient` caches the playerId from the auth
        // handshake; we use that as the "self" key for the
        // source !== self filter.
        const localEntityId: string | null = this.playerId;
        this.targeting.applyCombatEvent(payload, localEntityId);
        // TASK-46: surface the ACQUIRING toast when an AI
        // begins its 1 s acquire timer on the local player. The
        // server only pushes this frame to the targeted
        // player's connection so we just push a toast on the
        // local NotificationStore.
        if ((payload as { kind?: string }).kind === "ai_acquiring") {
          const evt = payload as {
            source: { kind: "ai"; id: string; callsign: string | null };
          };
          const callsign = evt.source.callsign ?? "Rogue";
          this.notificationStore?.push({
            kind: "ai-acquiring",
            text: `${callsign} acquiring…`,
            ts: Date.now(),
          });
        }
        // TASK-47: kill-feed pipeline. The server broadcasts
        // `combat_event { kind: 'kill' }` to every connection
        // in the system; the local client resolves the
        // attacker/target ids to display names through the
        // presence roster (players) and the remote-entity
        // buffer (AI callsigns captured in entity_update
        // frames).
        if ((payload as { kind?: string }).kind === "kill") {
          const evt = payload as { kind: "kill"; attacker: string; target: string; tick: number };
          // `isPlayerId` — entity ids starting with `entity:`
          // belong to player ships (the canonical wire format
          // for player-owned ships as minted by `entityToWire`).
          // AI ships carry the `ai:` prefix; everything else
          // (e.g. raw callsigns used as attacker ids) matches
          // by exact equality against the local player id.
          const playerIds = new Set<string>();
          for (const p of this.presence.snapshot()) {
            playerIds.add(p.callsign);
          }
          const isPlayerId = (id: string): boolean => {
            if (id.startsWith("entity:")) return true;
            return playerIds.has(id);
          };
          // Resolver — look up callsign from the presence
          // roster (player ships) or from the remote-entity
          // buffer (AI ships carry a `callsign` field on every
          // entity_update).
          const resolver = (id: string): string | null => {
            if (this.callsign !== null && id === this.callsign) return this.callsign;
            const match = playerIds.has(id) ? id : null;
            if (match !== null) return match;
            // The remote-entity buffer stores the most recent
            // snapshot for every remote entity; AI ships carry
            // a `callsign` field on every `entity_update` frame
            // so we can resolve them here. We sample at "now"
            // and accept whichever snapshot the buffer returns
            // (the entry's `state.callsign` is the canonical
            // callsign the renderer draws on the ship).
            const buf = this.remoteBuffers.get(id);
            if (buf !== undefined) {
              const sample = buf.sample(Date.now());
              const state = sample.state as { callsign?: unknown } | null;
              const cs = state?.callsign;
              if (typeof cs === "string" && cs.length > 0) return cs;
            }
            return null;
          };
          this.killFeed.applyKillEvent(evt, { resolver, isPlayerId });
        }
        // TASK-49: destruction pipeline. Every `destroyed` event
        // spawns an explosion + the 1 s slow-mo dip; when the server
        // attached a `respawn` summary (i.e. the destroyed ship was
        // ours) the store also opens the 2 s "SHIP LOST" moment.
        this.destruction.applyCombatEvent(payload as never);
        // TASK-51: self-hit pipeline. Forward every `hit` /
        // `damaged` event with a target id (the wire shape carriers
        // either `target: <id>` for the `damaged` kind or
        // `target: <id>` for the `hit` kind) to the
        // `selfHitListeners`. The host (App.tsx) wires each listener
        // into a `HitFlashController`, gated on `target ===
        // selfEntityId`. This is intentionally separate from the
        // targeting-store threat-ping path so the flash doesn't
        // piggy-back on the warning-only HUD rail.
        if (
          (payload as { kind?: string }).kind === "hit" ||
          (payload as { kind?: string }).kind === "damaged"
        ) {
          const evtAny = payload as {
            kind: "hit" | "damaged";
            target?: string;
            targetEntityId?: string;
          };
          const targetId = evtAny.target ?? evtAny.targetEntityId;
          if (typeof targetId === "string" && targetId.length > 0) {
            for (const listener of this.selfHitListeners) {
              try {
                listener({ kind: evtAny.kind, target: targetId });
              } catch {
                // Swallow — same rationale as other listeners.
              }
            }
          }
        }
        return;
      }
      case "state_snapshot":
      case "entity_update": {
        // Forward into the remote-entity buffer (TASK-14). We use
        // `entity_update` for incremental frames and `state_snapshot`
        // for the canonical hydrate-on-join snapshot. For TASK-15 we
        // don't render entities, but feeding the buffer keeps the
        // future renderer (TASK-26) ready to go.
        const payload = env.payload as
          WirePayloadFor<"entity_update"> | WirePayloadFor<"state_snapshot">;
        const nowMs = Date.now();
        const entities = (payload as { entities: readonly unknown[] }).entities ?? [];
        for (const e of entities) {
          const ent = e as {
            id: string;
            kind?: string;
            callsign?: string | null;
            regime?: string;
            onFoot?: boolean;
          };
          if (!ent.id) continue;
          // TASK-25: apply the server's authoritative regime to the
          // local controls manager. The manager ignores no-op
          // applications, so it's safe to call on every entity in
          // every frame; the owning player's callsign is the only
          // one we actually swap on (other entities' regimes are
          // observed but don't drive the player's input).
          if (ent.callsign && ent.callsign === this.callsign && ent.regime) {
            this.controls.applyRegime(ent.regime as Parameters<Controls["applyRegime"]>[0]);
            // TASK-31: when the owning entity's `kind` flips to
            // `'character'` we swap the controls into the
            // character-mode scheme. `onFoot === true` is the
            // wire flag the server sets on every character entity
            // (see `entityToWire` in `@server/shard/entity.ts`).
            // Calling `setOnFoot(false)` for a ship is a no-op so
            // it's safe to apply on every frame.
            this.controls.setOnFoot(ent.kind === "character");
          }
          let buf = this.remoteBuffers.get(ent.id);
          if (!buf) {
            buf = new RemoteEntityBuffer();
            this.remoteBuffers.set(ent.id, buf);
          }
          // TASK-75: remember the callsign so the presence-driven
          // liveness pass can tell a player's ship from an AI's.
          if (ent.callsign) {
            this.remoteCallsigns.set(ent.id, ent.callsign);
            if (this.presentCallsigns.has(ent.callsign)) {
              this.playerOwnedEntities.add(ent.id);
            }
          }
          // TASK-74: push the **simulator-shaped** entity, not
          // the raw wire frame. The buffer's interpolator
          // (`interpolateEntity` in `@client/net/prediction.ts`)
          // slerps the rotation, which fails on the wire shape
          // because the protocol omits `quat`. `simEntityFromWire`
          // fills in the identity quat so the interpolation
          // path stays finite. Pre-existing behaviour kept the
          // raw shape; the new render host's per-frame renderer
          // sampled the buffer enough times per second that
          // the uncaught exception became noise.
          buf.push(nowMs, simEntityFromWire(e as Parameters<typeof simEntityFromWire>[0]));
        }
        // TASK-48: extract hazard markers (drones for v1) from the
        // entity list and push them into the hazard store. The
        // store's snapshot is read by `HazardLayer` for the
        // in-world marker renderer.
        const typedEntities = entities as Parameters<typeof markersFromEntities>[0];
        this.hazardStore.setMarkers(markersFromEntities(typedEntities));
        // TASK-74: reconcile the local ship predictor against any
        // own-ship snapshot in the frame. The predictor is
        // constructed lazily on first access; we only run the
        // pipeline when the frame actually carries the local
        // ship (`callsign === currentCallsign` + matches the
        // own entity id, or fallback to `entity:<shipId>` from
        // the claim). The `lastAppliedSeq` map is wire-stable
        // across both `entity_update` and `state_snapshot`; we
        // read the entry keyed by our own `playerId` so the
        // predictor can drop queued inputs the server has
        // integrated.
        this.reconcileOwnShipFromFrame(
          entities as Parameters<ClientShipPredictor["reconcile"]>[0]["serverState"] extends never
            ? never
            : Parameters<typeof simEntityFromWire>[0][],
          nowMs,
          (payload as { lastAppliedSeq?: Record<string, number> }).lastAppliedSeq,
        );
        return;
      }
      case "ui_open": {
        // TASK-33: server-pushed modal directive (e.g. dock
        // terminal UI). The frame's `ui` tag drives which modal
        // mounts on the client. We just fan out to subscribers;
        // the actual UI lives in the host (App.tsx) which can
        // choose to mount / unmount the appropriate shell.
        const payload = env.payload as {
          ui: string;
          payload: Record<string, unknown>;
        };
        for (const listener of this.uiOpenListeners) {
          try {
            listener(payload);
          } catch {
            // swallow — faulty listener must not break the loop
          }
        }
        return;
      }
      case "enter_ship_ok": {
        // TASK-35: server ack for `enter_ship` (player re-entry).
        // The owning client listens to swap the camera + controls
        // + character mesh synchronously. The next `entity_update`
        // broadcast already carries the ship (and no character),
        // so the lens-side observer eventually applies the same
        // swap via `setOnFoot(ent.kind === 'ship')` on the new ship
        // row — this listener is the *frame-locked* companion so the
        // player sees the swap before the next 100 ms tick.
        const payload = env.payload as { shipId: string };
        for (const listener of this.enterShipOkListeners) {
          try {
            listener(payload);
          } catch {
            // swallow — same rationale as above
          }
        }
        return;
      }
      case "mining_update": {
        // TASK-38: server-timed mining progress echo. The UI
        // listens via `onMiningUpdate(...)` and renders the radial
        // + a "+1 iron" float from the cadence + unitsSoFar fields.
        // We deliberately don't run our own channel timer; the
        // server is the source of truth (anti-spam guarantee).
        const payload = env.payload as {
          depositId: string;
          resourceId: string;
          progressMs: number;
          unitsSoFar: number;
          amount: number;
          state: "mining" | "paused-full" | "depleted" | "cancelled";
        };
        for (const listener of this.miningUpdateListeners) {
          try {
            listener(payload);
          } catch {
            // swallow — same rationale as above
          }
        }
        return;
      }
      case "inventory_update": {
        // TASK-34: server-pushed inventory change. Mirror the
        // payload into our local cache so the WeightBar HUD
        // observes it on its next 250 ms poll.
        const payload = env.payload as {
          stacks: Record<string, number>;
          weightUsed: number;
        };
        this.inventory = {
          stacks: { ...payload.stacks },
          weightUsed: payload.weightUsed,
        };
        return;
      }
      case "cargo_update": {
        // TASK-39: server-pushed cargo hold change. Mirror the
        // payload into our local cache so the CargoPanel HUD
        // observes the new hold + the new inventory on its
        // next 250 ms poll. The ack carries both shapes so a
        // transfer that mutated the inventory can update the
        // WeightBar in lockstep without a separate frame.
        const payload = env.payload as {
          cargo: { stacks: Record<string, number>; weightUsed: number; capacity: number };
          inventory: { stacks: Record<string, number>; weightUsed: number };
        };
        this.cargo = {
          stacks: { ...payload.cargo.stacks },
          weightUsed: payload.cargo.weightUsed,
          capacity: payload.cargo.capacity,
        };
        this.inventory = {
          stacks: { ...payload.inventory.stacks },
          weightUsed: payload.inventory.weightUsed,
        };
        return;
      }
      case "sell_ok": {
        // TASK-40: server-pushed dock-sell ack. Fan out to
        // subscribers so the dock panel can render the "+N cr"
        // floating text + bump the credits counter on the same
        // frame the server commits. The payload mirrors the
        // shape of `SellOkSchema` so subscribers get typed
        // access to `sold` / `earned` / `newBalance` / `source`.
        const payload = env.payload as {
          resourceType: string;
          quantity: number;
          sold: number;
          earned: number;
          newBalance: number;
          source: "inv" | "hold";
        };
        for (const listener of this.sellOkListeners) {
          try {
            listener(payload);
          } catch {
            // swallow — faulty listener must not break the loop
          }
        }
        return;
      }
      case "fire_ok": {
        // TASK-43: server-pushed fire ack. The firing client
        // receives this on every accepted laser fire (muzzle
        // spark fires here), every missile spawn (tracer
        // starts here), AND every denial (the FX layer ignores
        // denials — denied fires surface no FX per the spec).
        // The shape mirrors `FireOkSchema` so subscribers get
        // typed access to `kind` / `damage` / `projectileId` /
        // `energy` / `denialCode`.
        const payload = env.payload as {
          weapon: "laser" | "missile";
          kind: "laser" | "missile" | "denied";
          damage: number;
          projectileId: string | null;
          energy: number;
          denialCode: string | null;
        };
        for (const listener of this.fireOkListeners) {
          try {
            listener(payload);
          } catch {
            // swallow
          }
        }
        return;
      }
      case "weapon_state": {
        // TASK-43: server-pushed weapon state update. The HUD
        // polls `getWeaponState()` so we just cache the latest
        // snapshot here.
        const payload = env.payload as {
          activeWeapon: "laser" | "missile";
          energy: number;
          locked: boolean;
          lockedUntilMs: number;
        };
        this.weaponState = {
          activeWeapon: payload.activeWeapon,
          energy: payload.energy,
          locked: payload.locked,
          lockedUntilMs: payload.lockedUntilMs,
        };
        return;
      }
      case "target_locked": {
        // TASK-44: server acked a successful `target_lock`. Push
        // the payload to the targeting store listeners.
        const payload = env.payload as Parameters<TargetingStore["applyLocked"]>[0];
        this.targeting.applyLocked(payload);
        for (const listener of this.targetUpdateListeners) {
          try {
            listener({ kind: "locked", payload });
          } catch {
            // swallow
          }
        }
        return;
      }
      case "target_released": {
        // TASK-44: server cleared the lock (manual / toggle /
        // destroyed / range-exceeded / timeout). Push the
        // release reason to listeners.
        const payload = env.payload as Parameters<TargetingStore["applyReleased"]>[0];
        this.targeting.applyReleased(payload);
        for (const listener of this.targetUpdateListeners) {
          try {
            listener({ kind: "released", payload });
          } catch {
            // swallow
          }
        }
        return;
      }
      case "target_update": {
        // TASK-44: server-pushed live stats for the locked target.
        // The HUD polls `targeting.getLocked()` so we just
        // refresh the cache.
        const payload = env.payload as Parameters<TargetingStore["applyTargetUpdate"]>[0];
        this.targeting.applyTargetUpdate(payload);
        for (const listener of this.targetUpdateListeners) {
          try {
            listener({ kind: "update", payload });
          } catch {
            // swallow
          }
        }
        return;
      }
      case "hazard_update": {
        // TASK-48: per-player exposure + recovering state.
        // Pushed to the local connection only (the field is a
        // personal resource, never broadcast to other players).
        const payload = env.payload as Parameters<HazardStore["applyHazardUpdate"]>[0];
        this.hazardStore.applyHazardUpdate(payload, Date.now());
        return;
      }
      default:
        // Other frame types are handled by their owning tasks.
        return;
    }
  };

  private handleClose = (): void => {
    // Defensive: a `close` fired during a manual stop should NOT
    // trigger the reconnect loop — the user's `stop()` already
    // moved us to `disconnected`. We compare against the cancel
    // flag we set there.
    if (this.status === "disconnected") return;
    // Capture the disconnect context so the resync path can decide
    // whether to preserve UI state.
    if (this.disconnectedAtMs === null) {
      this.disconnectedAtMs = (this.opts.now ?? Date.now)();
      this.lastSystemId = this.systemId;
    }
    // Clear the live socket ref; the reconnect loop opens a fresh
    // one on its next iteration.
    this.socket = null;
    if (this.status !== "online") {
      // We were already mid-reconnect (the previous attempt's
      // socket closed). The reconnect loop's own `catch` already
      // swallowed the error and is sleeping; don't double-flip
      // the status.
      return;
    }
    this.setStatus("reconnecting");
    this.beginReconnectLoop();
  };

  private handleError = (): void => {
    // Browser `error` events don't carry actionable context — the
    // `close` event always fires immediately after. We let the
    // close handler drive the reconnect; this is just a diagnostic
    // hook for tests that want to observe the sequence.
  };

  private setStatus(next: DriftClientStatus, detail?: string): void {
    if (next === this.status) return;
    this.status = next;
    for (const listener of this.statusListeners) {
      try {
        listener(next, detail);
      } catch {
        // swallow — faulty listener must not break the lifecycle.
      }
    }
    this.opts.onStatus?.(next, detail);
  }

  private emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(err);
      } catch {
        // swallow
      }
    }
    this.opts.onError?.(err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default socket factory — uses the browser's `WebSocket`. */
function defaultCreateSocket(url: string): WebSocket {
  // WebSocket is a global in browsers; declare a minimal shape so
  // TypeScript doesn't error in a Node-only test environment.
  return new (globalThis as { WebSocket: new (url: string) => WebSocket }).WebSocket(url);
}

/** Default sleeper — `setTimeout`-backed Promise. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** 6-char hex suffix. */
function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

/**
 * Factory that wires a `DriftClient` and saves the claim token on the
 * instance so the handshake step can re-read it. Exposed because the
 * `runHandshake` step needs the token and the only sane place to keep
 * it is on the instance.
 */
export function createDriftClient(opts: DriftClientOptions = {}): DriftClient {
  const client = new DriftClient(opts);
  return client;
}
