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

import { PresenceStore } from "./presence.js";
import { ChatStore } from "./chat.js";
import { RemoteEntityBuffer } from "./prediction.js";
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
  private status: DriftClientStatus = "idle";
  private playerId: string | null = null;
  private callsign: string | null = null;
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
    const nowMs = (this.opts.now ?? Date.now)();
    for (const entity of payload.entities) {
      const ent = entity as { id: string };
      if (!ent.id) continue;
      let buf = this.remoteBuffers.get(ent.id);
      if (!buf) {
        buf = new RemoteEntityBuffer();
        this.remoteBuffers.set(ent.id, buf);
      }
      buf.push(nowMs, entity as never);
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
    this.opts.remoteBufferRegistry?.reset();
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
          buf.push(nowMs, e as never);
        }
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
