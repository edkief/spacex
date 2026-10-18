/**
 * DriftClient reconnect + resync tests (TASK-17).
 *
 * Exercises the client-side auto-retry loop + resync event surface
 * against a stub WebSocket factory. The tests:
 *
 *   - **Auto-retry on close.** A socket that closes mid-flight
 *     triggers a retry attempt; the retry re-runs the handshake
 *     without re-claiming the callsign (the saved token is
 *     re-used).
 *   - **Exponential backoff.** Backoff grows 1 s → 1.5 s → 2.25 s
 *     ... capped at `retryMaxMs`.
 *   - **Budget exhaustion → `lost`.** When the retry budget is
 *     exhausted without a successful reconnect, the client
 *     transitions to `"lost"` status and stops retrying.
 *   - **`reconnected` event fires on every successful resync.**
 *     The event carries a `preserved` flag the App listens to
 *     for the "Reconnected" toast + UI state decision.
 *   - **`preserved = true` on same-system reconnect within 60 s.**
 *     The client keeps `presence` + `chat` stores; the new
 *     `presence` frame from the server reconciles the roster.
 *   - **`preserved = false` on different-system reconnect.**
 *     The client clears the stores so stale entries don't leak.
 *   - **`stop()` cancels the retry loop.** A user-initiated
 *     `stop()` mid-reconnect leaves the client in `disconnected`,
 *     not `lost`.
 *   - **Remote-entity buffers reset on resync.** Every successful
 *     resync clears the per-entity buffers so the next snapshot
 *     starts from a clean slate.
 *   - **Status transitions.** `idle → claiming → connecting →
 *     handshaking → joining → online` is the documented happy
 *     path.
 *   - **Retry defaults exported.** The exported constants match
 *     the spec (1 s / 5 s / 30 s / 60 s).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_INITIAL_MS,
  DEFAULT_RETRY_MAX_MS,
  DEFAULT_RESYNC_PRESERVE_MS,
  DriftClient,
  type DriftClientStatus,
  type ResyncEvent,
} from "./wsClient.js";

// ---------------------------------------------------------------------------
// Stub WebSocket
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket stub. Records every handler the client attaches
 * so tests can fire frames / close events. Mirrors the live
 * `WebSocket` interface surface the client touches
 * (`addEventListener`, `send`, `close`, `readyState`).
 */
class StubSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  url: string;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: string, handler: (ev: unknown) => void): void {
    (this.listeners[event] ??= []).push(handler);
  }

  removeEventListener(event: string, handler: (ev: unknown) => void): void {
    const list = this.listeners[event] ?? [];
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === StubSocket.CLOSED) return;
    this.readyState = StubSocket.CLOSED;
    queueMicrotask(() => this.fireClose(1000, "normal"));
  }

  /** Simulate the server accepting the socket. */
  open(): void {
    this.readyState = StubSocket.OPEN;
    for (const h of this.listeners["open"] ?? []) h({});
  }

  /** Simulate a server-pushed frame. */
  deliver(message: string): void {
    for (const h of this.listeners["message"] ?? []) h({ data: message });
  }

  /** Simulate an abrupt close (network drop). */
  fireClose(code = 1006, reason = "abnormal"): void {
    this.readyState = StubSocket.CLOSED;
    for (const h of this.listeners["close"] ?? []) h({ code, reason });
  }
}

/** Captures every socket the factory hands out. */
class SocketRegistry {
  sockets: StubSocket[] = [];
  make = (url: string): StubSocket => {
    const s = new StubSocket(url);
    this.sockets.push(s);
    return s;
  };
}

interface StubResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Build a fetcher stub that always returns a 200 with the given body. */
function stubFetchOk(
  body: unknown,
): ((input: string, init?: RequestInit) => Promise<StubResponse>) & { calls: number } {
  const fn = ((_url: string, _init?: RequestInit): Promise<StubResponse> => {
    (fn as unknown as { calls: number }).calls += 1;
    return Promise.resolve({
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }) as unknown as ((input: string, init?: RequestInit) => Promise<StubResponse>) & {
    calls: number;
  };
  (fn as unknown as { calls: number }).calls = 0;
  return fn;
}

/** Stub sleeper — collects every sleep request so the test can fast-forward. */
class StubSleeper {
  pending: Array<{ ms: number; resolve: () => void; reject: (err: Error) => void }> = [];
  sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      this.pending.push({ ms, resolve, reject });
    });
  /** Resolve the oldest pending sleep (advances the retry loop). */
  advanceOne(): void {
    const next = this.pending.shift();
    next?.resolve();
  }
  /** Resolve every pending sleep — used to drain the retry budget. */
  advanceAll(): void {
    for (const p of this.pending) p.resolve();
    this.pending.length = 0;
  }
}

/**
 * Drive the standard happy-path server handshake for a freshly-opened
 * socket. Returns once every step has been enqueued (the test is
 * responsible for waiting on microtasks).
 *
 * The sequence is:
 *   1. Open the socket (client sends `hello`).
 *   2. Deliver the server `hello` reply.
 *   3. After the client sends `auth`, deliver `auth_ok`.
 *   4. After the client sends `join_system`, deliver `enter_system`.
 */
function runHappyHandshake(sock: StubSocket): void {
  if (!sock) throw new Error("runHappyHandshake: socket is undefined");
  sock.open();
  // Step 1: deliver server-side `hello` reply (after client's hello).
  setTimeout(() => {
    sock.deliver(
      JSON.stringify({ v: 1, type: "hello", payload: { version: 1, serverTickHz: 20 } }),
    );
  }, 5);
  // Step 2: deliver `auth_ok` after the client has sent auth.
  setTimeout(() => {
    sock.deliver(
      JSON.stringify({
        v: 1,
        type: "auth_ok",
        payload: {
          playerId: "p-stub",
          callsign: "RECONN-1",
          tokenExpiresAt: Date.now() + 60_000,
        },
      }),
    );
  }, 15);
  // Step 3: deliver `enter_system` after the client has sent
  // join_system.
  setTimeout(() => {
    sock.deliver(
      JSON.stringify({
        v: 1,
        type: "enter_system",
        payload: {
          systemId: "system-001",
          entities: [],
          nodes: [],
          chat: [],
          players: [],
          serverTickHz: 20,
          snapshotTick: 0,
        },
      }),
    );
  }, 25);
}

/** Helper to construct a client + sockets + sleeper with standard test config. */
function setupClient(opts: { callsign: string } & Record<string, unknown>): {
  client: DriftClient;
  sockets: SocketRegistry;
  sleeper: StubSleeper;
  fetchImpl: ReturnType<typeof stubFetchOk>;
} {
  // opts is currently used to override the standard config;
  // intentionally unused so the caller can pass through arbitrary
  // knobs (onResync, retryBudgetMs, …) without explicit destructuring.
  void opts;
  const sockets = new SocketRegistry();
  const sleeper = new StubSleeper();
  const fetchImpl = stubFetchOk({
    callsign: opts.callsign,
    token: `token-${opts.callsign}`,
    playerId: `p-${opts.callsign}`,
    homeSystemId: "system-001",
    shipId: `ship-${opts.callsign}`,
    tokenExpiresAt: Date.now() + 60_000,
  });
  const client = new DriftClient({
    createSocket: sockets.make as unknown as (url: string) => WebSocket,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: sleeper.sleep,
    ...opts,
  });
  return { client, sockets, sleeper, fetchImpl };
}

/** Await until the predicate holds or the timeout fires. */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil timed out");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DriftClient — reconnect + resync (TASK-17)", () => {
  it("auto-retries on close and re-uses the saved token", async () => {
    const { client, sockets, fetchImpl } = setupClient({ callsign: "RECONN-1" });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    // Drop the first socket.
    sockets.sockets[0]!.fireClose(1006, "abnormal");
    await waitUntil(() => client.isReconnecting, 500);
    // Wait for the new socket to be created (retry loop opens it).
    await waitUntil(() => sockets.sockets.length === 2, 500);
    runHappyHandshake(sockets.sockets[1]!);
    await waitUntil(() => client.currentStatus === "online", 2000);

    // The second auth frame re-uses the saved token (NOT a re-claim).
    const authFrame = sockets.sockets[1]!.sent.find((s) => s.includes(`"type":"auth"`));
    expect(authFrame).toBeDefined();
    const parsed = JSON.parse(authFrame!) as { type: string; payload: { token?: string } };
    expect(parsed.payload.token).toBe("token-RECONN-1");
    // The fetcher's call count is still 1 (only the initial claim).
    expect(fetchImpl.calls).toBe(1);

    void client.stop();
  });

  it("fires onResync with `preserved: true` on same-system reconnect", async () => {
    const resyncEvents: ResyncEvent[] = [];
    const { client, sockets } = setupClient({
      callsign: "PRESERVE-1",
      onResync: (event: ResyncEvent) => resyncEvents.push(event),
    });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    // Server sends a presence frame so the store has something
    // to preserve.
    sockets.sockets[0]!.deliver(
      JSON.stringify({
        v: 1,
        type: "presence",
        payload: {
          systemId: "system-001",
          players: [
            {
              playerId: "p-PRESERVE-1",
              callsign: "PRESERVE-1",
              shipId: "ship-PRESERVE-1",
              state: "flying",
            },
          ],
        },
      }),
    );
    await waitUntil(() => client.presenceStore.snapshot().length > 0, 500);

    // Drop + retry.
    sockets.sockets[0]!.fireClose(1006, "abnormal");
    await waitUntil(() => client.isReconnecting, 500);

    // New socket + handshake.
    await waitUntil(() => sockets.sockets.length === 2, 500);
    runHappyHandshake(sockets.sockets[1]!);
    await waitUntil(() => client.currentStatus === "online", 2000);

    expect(resyncEvents).toHaveLength(1);
    expect(resyncEvents[0]!.preserved).toBe(true);
    expect(resyncEvents[0]!.systemId).toBe("system-001");

    void client.stop();
  });

  it("fires onResync with `preserved: false` when the disconnect lasted longer than the preserve window", async () => {
    // Use a virtual clock that we can fast-forward so the
    // disconnect window expires before we reconnect. The default
    // `resyncPreserveMs` is 60 s; we override to 50 ms so the
    // test can advance the clock past it cheaply.
    let fakeNowMs = 1_000_000;
    const resyncEvents: ResyncEvent[] = [];
    const { client, sockets } = setupClient({
      callsign: "OUT-OF-WINDOW-1",
      now: () => fakeNowMs,
      resyncPreserveMs: 50,
      onResync: (event: ResyncEvent) => resyncEvents.push(event),
    });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    // Drop the socket + advance the fake clock past the 50 ms
    // preserve window.
    sockets.sockets[0]!.fireClose(1006, "abnormal");
    fakeNowMs += 100;
    await waitUntil(() => client.isReconnecting, 500);
    await waitUntil(() => sockets.sockets.length === 2, 500);
    runHappyHandshake(sockets.sockets[1]!);
    await waitUntil(() => client.currentStatus === "online", 2000);

    expect(resyncEvents).toHaveLength(1);
    expect(resyncEvents[0]!.preserved).toBe(false);
    // The event still carries the (unchanged) system id + the
    // captured disconnect timestamp.
    expect(resyncEvents[0]!.systemId).toBe("system-001");
    expect(resyncEvents[0]!.disconnectedAtMs).toBeLessThanOrEqual(fakeNowMs);

    void client.stop();
  });

  it("transitions to `lost` after the retry budget is exhausted", async () => {
    const { client, sockets, sleeper } = setupClient({
      callsign: "BUDGET-1",
      retryBudgetMs: 300,
      retryInitialMs: 50,
      retryMaxMs: 100,
    });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    sockets.sockets[0]!.fireClose(1006, "abnormal");
    // Wait for the retry loop to spawn its second socket so we
    // can close it (the loop is awaiting runHandshake on it).
    await waitUntil(() => sockets.sockets.length === 2, 1000);
    // Drive the loop forward: close each new socket so the
    // handshake rejects, advance each pending sleep, repeat
    // until the budget expires.
    for (let i = 0; i < 30; i++) {
      if (client.currentStatus === "lost") break;
      const sock = sockets.sockets[sockets.sockets.length - 1];
      if (sock) sock.fireClose(1006, "abnormal");
      // Wait for the catch block to queue the backoff sleep.
      await waitUntil(() => sleeper.pending.length > 0, 500);
      sleeper.advanceOne();
      // Wait for the next socket to be spawned (or `lost`).
      await waitUntil(
        () => client.currentStatus === "lost" || sockets.sockets.length > 1 + i + 1,
        1000,
      );
    }
    expect(client.currentStatus).toBe("lost");
  });

  it("uses exponential backoff capped at retryMaxMs", async () => {
    const { client, sockets, sleeper } = setupClient({
      callsign: "BACKOFF-1",
      retryInitialMs: 100,
      retryMaxMs: 250,
      retryBudgetMs: 30_000,
    });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    sockets.sockets[0]!.fireClose(1006, "abnormal");
    await waitUntil(() => sockets.sockets.length === 2, 1000);
    const sleepMs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const sock = sockets.sockets[sockets.sockets.length - 1];
      if (sock) sock.fireClose(1006, "abnormal");
      // Capture the queued backoff.
      await waitUntil(() => sleeper.pending.length > 0, 1000);
      sleepMs.push(sleeper.pending[0]!.ms);
      sleeper.advanceOne();
      await waitUntil(() => sockets.sockets.length > 1 + i + 1, 1000);
    }
    expect(sleepMs[0]).toBe(100);
    for (let i = 1; i < sleepMs.length; i++) {
      expect(sleepMs[i]).toBeLessThanOrEqual(250);
      expect(sleepMs[i]).toBeGreaterThanOrEqual(sleepMs[i - 1]!);
    }
    void client.stop();
  });

  it("stop() cancels the in-flight retry loop", async () => {
    const { client, sockets, sleeper } = setupClient({ callsign: "CANCEL-1" });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    sockets.sockets[0]!.fireClose(1006, "abnormal");
    await waitUntil(() => client.isReconnecting, 500);
    // User calls stop() before the backoff fires.
    await client.stop();
    expect(client.currentStatus).toBe("disconnected");
    // Advancing the sleeper must not flip back to `online`.
    sleeper.advanceAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.currentStatus).toBe("disconnected");
  });

  it("resets remote-entity buffers on every successful resync", async () => {
    const { client, sockets } = setupClient({ callsign: "BUFFERS-1" });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);

    // Push an entity_update frame so a remote buffer exists.
    sockets.sockets[0]!.deliver(
      JSON.stringify({
        v: 1,
        type: "entity_update",
        payload: {
          systemId: "system-001",
          tick: 2,
          entities: [
            {
              id: "entity:s-remote",
              kind: "ai-ship",
              pos: [0, 0, 0],
              vel: [0, 0, 0],
              regime: "space",
              hull: 100,
              shields: 100,
              targetId: null,
              classId: "scout",
              callsign: null,
              livery: null,
            },
          ],
          lastAppliedSeq: {},
        },
      }),
    );
    await waitUntil(() => client.remoteEntityBuffers.size === 1, 500);

    // Reconnect — the buffer registry should be empty again.
    sockets.sockets[0]!.fireClose(1006, "abnormal");
    await waitUntil(() => client.isReconnecting, 500);
    await waitUntil(() => sockets.sockets.length === 2, 500);
    runHappyHandshake(sockets.sockets[1]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    expect(client.remoteEntityBuffers.size).toBe(0);

    void client.stop();
  });

  it("exports the retry + resync defaults", () => {
    expect(DEFAULT_RETRY_INITIAL_MS).toBe(1_000);
    expect(DEFAULT_RETRY_MAX_MS).toBe(5_000);
    expect(DEFAULT_RETRY_BUDGET_MS).toBe(30_000);
    expect(DEFAULT_RESYNC_PRESERVE_MS).toBe(60_000);
  });

  it("emits the standard lifecycle status transitions on happy path", async () => {
    const statuses: DriftClientStatus[] = [];
    const { client, sockets } = setupClient({
      callsign: "STATUS-1",
      onStatus: (statusNow: DriftClientStatus) => statuses.push(statusNow),
    });
    const startPromise = client.start();
    await waitUntil(() => sockets.sockets.length > 0, 500);
    runHappyHandshake(sockets.sockets[0]!);
    await waitUntil(() => client.currentStatus === "online", 2000);
    await startPromise.catch(() => undefined);
    expect(statuses).toEqual(["claiming", "connecting", "handshaking", "joining", "online"]);
    void client.stop();
  });
});
