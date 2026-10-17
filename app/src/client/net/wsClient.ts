/**
 * Client-side WebSocket glue (TASK-15).
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
 * The client surfaces a small lifecycle hook API for the React
 * shell: `onStatusChange`, `onError`. The store is the only
 * authoritative state surface; React subscribes to it directly via
 * `useSyncExternalStore`.
 *
 * The client is pure TypeScript with no React dependency so it
 * can be unit-tested against a real Fastify server (or a mocked
 * `WebSocket`). The `createDriftClient` factory accepts a
 * `WebSocketFactory` so tests can inject a stub.
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
import { RemoteEntityBuffer } from "./prediction.js";
import type { PayloadFor as WirePayloadFor } from "@shared/protocol/index.js";

/** Connection lifecycle states surfaced to the UI. */
export type DriftClientStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "handshaking"
  | "joining"
  | "online"
  | "disconnected"
  | "error";

/** Lifecycle observer. */
export type StatusListener = (status: DriftClientStatus, detail?: string) => void;

/** Error observer. */
export type ErrorListener = (err: Error) => void;

/** Default factory — `WebSocket` from the global scope in the browser. */
export type WebSocketFactory = (url: string) => WebSocket;

/** Default HTTP fetcher — `fetch` from the global scope in the browser. */
export type Fetcher = typeof fetch;

/** Public options bag. */
export interface DriftClientOptions {
  /** Override the WebSocket factory for tests. */
  createSocket?: WebSocketFactory;
  /** Override the fetch implementation for tests. */
  fetchImpl?: Fetcher;
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
  /** Optional status lifecycle observer. */
  onStatus?: StatusListener;
  /** Optional error observer. */
  onError?: ErrorListener;
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
 * Thin WS client wrapping the Drift handshake. See file header
 * for the lifecycle.
 */
export class DriftClient {
  private readonly opts: DriftClientOptions;
  private readonly presence: PresenceStore;
  private readonly remoteBuffer: RemoteEntityBuffer;
  private readonly remoteBuffers = new Map<string, RemoteEntityBuffer>();
  private socket: WebSocket | null = null;
  private status: DriftClientStatus = "idle";
  private playerId: string | null = null;
  private callsign: string | null = null;
  private token: string | null = null;
  private systemId: string | null = null;
  private statusListeners = new Set<StatusListener>();
  private errorListeners = new Set<ErrorListener>();

  constructor(opts: DriftClientOptions = {}) {
    this.opts = opts;
    this.presence = opts.presenceStore ?? new PresenceStore();
    this.remoteBuffer = opts.remoteBuffer ?? new RemoteEntityBuffer();
  }

  /** The presence store. The React shell subscribes via this reference. */
  get presenceStore(): PresenceStore {
    return this.presence;
  }

  /** The remote-entity buffer (TASK-14). */
  get remoteEntityBuffer(): RemoteEntityBuffer {
    return this.remoteBuffer;
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

  /** System id after `enter_system`, or `null` until then. */
  get currentSystemId(): string | null {
    return this.systemId;
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
   * Drive the full lifecycle: claim → handshake → join. Returns
   * once the client is `online` (post-`enter_system`) or throws on
   * failure. Errors are also forwarded to every registered error
   * listener.
   */
  async start(): Promise<void> {
    if (this.status === "online" || this.status === "joining") return;
    try {
      this.setStatus("claiming");
      const claim = await this.claimCallsignWithRetry();
      this.callsign = claim.callsign;
      this.token = claim.token;
      this.presence.setOwnCallsign(claim.callsign);

      this.setStatus("connecting");
      const origin = this.opts.origin ?? (typeof location !== "undefined" ? location.origin : "");
      const wsPath = this.opts.wsPath ?? "/ws";
      const wsUrl = origin ? `${origin.replace(/^http/, "ws")}${wsPath}` : `${wsPath}`;
      const socket = (this.opts.createSocket ?? defaultCreateSocket)(wsUrl);
      this.socket = socket;

      // Attach the persistent message + close handlers BEFORE the
      // handshake so presence / entity_update frames that fire
      // during the join aren't lost (the router broadcasts the
      // presence frame BEFORE enter_system resolves — see
      // `router.ws-bridge.test.ts`).
      socket.addEventListener("message", this.handleMessage);
      socket.addEventListener("close", this.handleClose);

      this.setStatus("handshaking");
      await this.runHandshake(socket);

      this.setStatus("joining");
      const targetSystem = this.opts.systemId ?? claim.homeSystemId;
      await this.runJoin(socket, targetSystem);
      this.systemId = targetSystem;

      this.setStatus("online");
    } catch (err) {
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
    if (this.socket) {
      try {
        this.socket.close(1000, "client-stop");
      } catch {
        // ignore — the socket may already be closed
      }
    }
    this.socket = null;
    this.presence.leaveAll();
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
    // Clear the local roster so any HUD mounted during the join
    // doesn't render stale entries.
    this.presence.leaveAll();
    await this.runJoin(this.socket, systemId);
    this.systemId = systemId;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

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
      const onOpen = () => {
        if (this.token) {
          socket.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        }
      };
      const onMessage = (event: MessageEvent) => {
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
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError);
          resolve();
          return;
        }
        if (env.type === "error") {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError);
          reject(new Error(`handshake error: ${(env.payload as { message: string }).message}`));
          return;
        }
      };
      const onError = (event: Event) => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        reject(new Error(`socket error: ${(event as ErrorEvent).message ?? "unknown"}`));
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
    });
  }

  private runJoin(socket: WebSocket, systemId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
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
          void (env.payload as PayloadFor<"enter_system">);
          socket.removeEventListener("message", onMessage);
          resolve();
          return;
        }
        if (env.type === "error") {
          socket.removeEventListener("message", onMessage);
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
          const ent = e as { id: string; kind?: string };
          if (!ent.id) continue;
          let buf = this.remoteBuffers.get(ent.id);
          if (!buf) {
            buf = new RemoteEntityBuffer();
            this.remoteBuffers.set(ent.id, buf);
          }
          buf.push(nowMs, e as never);
        }
        return;
      }
      default:
        // Other frame types are handled by their owning tasks.
        return;
    }
  };

  private handleClose = (): void => {
    this.presence.leaveAll();
    this.setStatus("disconnected");
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
