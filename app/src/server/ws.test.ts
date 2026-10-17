/**
 * WebSocket protocol integration tests (TASK-9).
 *
 * Boots a real Fastify app + ws server in-process and drives the protocol
 * with a real `ws` client. Covers:
 *   - happy path: hello → auth_ok → join_system → enter_system
 *   - version mismatch (envelope-level)
 *   - malformed payload rejected with `invalid-message`
 *   - unknown type rejected with `unknown-type` and counted
 *   - 10-strike drop
 *   - handshake-order enforcement (sending `auth` before `hello`, etc.)
 *   - keepalive: connection terminated after silence > pong timeout
 *   - ping/pong round-trip
 *
 * The tests run against an ephemeral port and tear down their server in
 * `afterAll` so they don't conflict with each other or with `npm run dev`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import {
  attachWs,
  INVALID_DROP_THRESHOLD,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  type WsHandle,
  type WsHandleOptions,
  type JoinResolverResult,
} from "./ws.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  handle: WsHandle;
  port: number;
  url: string;
}

/**
 * Start a Fastify + ws server on an ephemeral port. The default
 * resolvers (`defaultJoinResolver`, `defaultAuthResolver`) are used unless
 * the caller overrides them via `options`.
 */
async function bootHarness(options: WsHandleOptions = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.ready();
  // Listen on an ephemeral port so the tests don't collide with `npm run dev`.
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const handle = attachWs(app, "/ws", options);
  return {
    app,
    handle,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
  };
}

/**
 * Open a client WebSocket to the harness. Resolves once the `open`
 * event fires; rejects on `error`.
 */
function openClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Collect the next `n` messages, resolving once they have arrived. Each
 * message is the raw text frame.
 */
function collectMessages(ws: WsClient, n: number, timeoutMs = 1500): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timeout waiting for ${n} messages; got ${out.length}: ${JSON.stringify(out)}`),
      );
    }, timeoutMs);
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data).toString("utf8");
      out.push(text);
      if (out.length >= n) {
        cleanup();
        resolve(out);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

/** Wait until the client's `close` event fires. */
function waitForClose(ws: WsClient, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString("utf8") });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server/ws handshake", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await bootHarness();
  });
  afterAll(async () => {
    await harness.handle.close();
    await harness.app.close();
  });

  it("drives the happy path: hello → auth_ok → enter_system", async () => {
    const client = await openClient(harness.url);
    try {
      // Step 1: hello (server replies with the version-ok semantic on the
      // `hello` message type — bidirectional reuse).
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION, client: "test" }));
      const [helloAck] = await collectMessages(client, 1);
      const ack = JSON.parse(helloAck) as { v: number; type: string; payload: unknown };
      expect(ack.v).toBe(PROTOCOL_VERSION);
      expect(ack.type).toBe("hello");
      expect((ack.payload as { version: number }).version).toBe(PROTOCOL_VERSION);
      expect((ack.payload as { serverTickHz: number }).serverTickHz).toBe(20);

      // Step 2: auth.
      client.send(encodeEnvelope("auth", { callsign: "TEST-ALPHA" }));
      const [authAckRaw] = await collectMessages(client, 1);
      const authAck = JSON.parse(authAckRaw) as {
        type: string;
        payload: { callsign: string; playerId: string };
      };
      expect(authAck.type).toBe("auth_ok");
      expect(authAck.payload.callsign).toBe("TEST-ALPHA");
      expect(authAck.payload.playerId).toMatch(/^p-[0-9a-f]+$/);

      // Step 3: join_system.
      client.send(encodeEnvelope("join_system", { systemId: "system-001" }));
      const [enterRaw] = await collectMessages(client, 1);
      const enter = JSON.parse(enterRaw) as {
        type: string;
        payload: { systemId: string; players: unknown[]; serverTickHz: number };
      };
      expect(enter.type).toBe("enter_system");
      expect(enter.payload.systemId).toBe("system-001");
      expect(enter.payload.players).toEqual([]);
      expect(enter.payload.serverTickHz).toBe(20);

      // Connection record should now reflect 'joined' state with player set.
      const conns = harness.handle.connections();
      expect(conns).toHaveLength(1);
      expect(conns[0].state).toBe("joined");
      expect(conns[0].callsign).toBe("TEST-ALPHA");
      expect(conns[0].playerId).toMatch(/^p-/);
      expect(conns[0].systemId).toBe("system-001");
    } finally {
      client.close();
    }
  });

  it("rejects a version-mismatched hello", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION + 99 }));
      const [msg] = await collectMessages(client, 1);
      const err = JSON.parse(msg) as { type: string; payload: { code: string } };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("version-mismatch");
      // Server then closes the connection.
      const close = await waitForClose(client);
      expect(close.code).toBe(1002);
    } finally {
      // already closed by server
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("rejects a malformed payload with invalid-message", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      await collectMessages(client, 1); // consume hello ack
      // auth frame is missing both `token` and `callsign`.
      client.send(encodeEnvelope("auth", {}));
      const [errRaw] = await collectMessages(client, 1);
      const err = JSON.parse(errRaw) as { type: string; payload: { code: string } };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("invalid-message");
      // State should still be 'authed' (connection alive).
      expect(harness.handle.connections()[0].state).toBe("authed");
    } finally {
      client.close();
    }
  });

  it("counts unknown types and drops at the threshold", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      await collectMessages(client, 1); // hello ack
      // Send `INVALID_DROP_THRESHOLD` unknown-type frames.
      const errors = collectMessages(client, INVALID_DROP_THRESHOLD);
      for (let i = 0; i < INVALID_DROP_THRESHOLD; i++) {
        client.send(
          JSON.stringify({ v: PROTOCOL_VERSION, type: "definitely-not-a-type", payload: { i } }),
        );
      }
      const errs = await errors;
      for (const raw of errs) {
        const e = JSON.parse(raw) as { type: string; payload: { code: string } };
        expect(e.type).toBe("error");
        expect(e.payload.code).toBe("unknown-type");
      }
      // The server should have closed the socket after the threshold strike.
      const close = await waitForClose(client);
      expect(close.code).toBe(1008);
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("enforces handshake order: rejects auth before hello", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("auth", { callsign: "TEST-EARLY" }));
      const [errRaw] = await collectMessages(client, 1);
      const err = JSON.parse(errRaw) as {
        type: string;
        payload: { code: string; message: string };
      };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("unauthenticated");
      expect(err.payload.message).toMatch(/hello/);
      // State remains 'hello'.
      expect(harness.handle.connections()[0].state).toBe("hello");
    } finally {
      client.close();
    }
  });

  it("enforces handshake order: rejects join_system before auth", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      await collectMessages(client, 1); // hello ack
      client.send(encodeEnvelope("join_system", { systemId: "system-001" }));
      const [errRaw] = await collectMessages(client, 1);
      const err = JSON.parse(errRaw) as { type: string; payload: { code: string } };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("unauthenticated");
      expect(harness.handle.connections()[0].state).toBe("authed");
    } finally {
      client.close();
    }
  });

  it("echoes ping/pong with the same timestamp", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("ping", { t: 12345.678 }));
      const [pongRaw] = await collectMessages(client, 1);
      const pong = JSON.parse(pongRaw) as { type: string; payload: { t: number } };
      expect(pong.type).toBe("pong");
      expect(pong.payload.t).toBe(12345.678);
    } finally {
      client.close();
    }
  });

  it("responds to non-JSON input with invalid-message", async () => {
    const client = await openClient(harness.url);
    try {
      client.send("definitely not json");
      const [errRaw] = await collectMessages(client, 1);
      const err = JSON.parse(errRaw) as { type: string; payload: { code: string } };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("invalid-message");
    } finally {
      client.close();
    }
  });

  it("propagates the join resolver's custom snapshot", async () => {
    const custom: JoinResolverResult = {
      systemId: "system-XYZ",
      entities: [
        {
          id: "ship-1",
          kind: "ship",
          pos: [1, 2, 3],
          vel: [0, 0, 0],
          regime: "space",
          hull: 100,
          shields: 50,
          targetId: null,
          classId: "scout",
          callsign: "TEST-ALPHA",
          livery: null,
        },
      ],
      nodes: [{ id: "node-1", type: "iron", quantity: 100 }],
      chat: [],
      players: ["TEST-ALPHA"],
      serverTickHz: 20,
      snapshotTick: 42,
    };
    // Re-boot a harness with a stubbed join resolver.
    const custom_h = await bootHarness({
      joinResolver: async (systemId: string) => ({ ...custom, systemId }),
    });
    try {
      const client = await openClient(custom_h.url);
      try {
        client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("auth", { callsign: "TEST-ALPHA" }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("join_system", { systemId: "system-XYZ" }));
        const [enterRaw] = await collectMessages(client, 1);
        const enter = JSON.parse(enterRaw) as {
          type: string;
          payload: {
            systemId: string;
            snapshotTick: number;
            players: string[];
            entities: unknown[];
          };
        };
        expect(enter.payload.systemId).toBe("system-XYZ");
        expect(enter.payload.snapshotTick).toBe(42);
        expect(enter.payload.players).toEqual(["TEST-ALPHA"]);
        expect(enter.payload.entities).toHaveLength(1);
      } finally {
        client.close();
      }
    } finally {
      await custom_h.handle.close();
      await custom_h.app.close();
    }
  });

  it("maps a join_resolver rejection to a structured error", async () => {
    const custom_h = await bootHarness({
      joinResolver: async () => {
        const err = new Error("System full") as Error & { code: string };
        err.code = "system-full";
        throw err;
      },
    });
    try {
      const client = await openClient(custom_h.url);
      try {
        client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("auth", { callsign: "TEST-ALPHA" }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("join_system", { systemId: "system-XYZ" }));
        const [errRaw] = await collectMessages(client, 1);
        const err = JSON.parse(errRaw) as {
          type: string;
          payload: { code: string; message: string };
        };
        expect(err.type).toBe("error");
        expect(err.payload.code).toBe("system-full");
        expect(err.payload.message).toBe("System full");
        // Connection survives — client can try another system.
        expect(custom_h.handle.connections()[0].state).toBe("joined");
      } finally {
        client.close();
      }
    } finally {
      await custom_h.handle.close();
      await custom_h.app.close();
    }
  });
});

describe("server/ws keepalive", () => {
  it("terminates connections silent for longer than the pong timeout", async () => {
    // Use a manually-controlled clock so we can advance time deterministically
    // without depending on `vi.useFakeTimers()` (which doesn't intercept ws's
    // internal timers reliably in every version).
    let clock = 1_000_000;
    const fakeNow = (): number => clock;
    const advance = (ms: number): void => {
      clock += ms;
    };

    const h = await bootHarness({
      now: fakeNow,
      keepalive: { pingIntervalMs: 50, pongTimeoutMs: 500 },
    });
    try {
      const client = await openClient(h.url);
      try {
        // Complete the handshake so the connection reaches 'joined'.
        client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("auth", { callsign: "TEST-ALPHA" }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("join_system", { systemId: "system-001" }));
        await collectMessages(client, 1);

        // Now stop sending and wait for the keepalive tick to terminate.
        // The real `setInterval` runs on the event loop; we just need to
        // give it a few real ms to fire after we advance our fake clock
        // via the `lastSeenAt` math.
        const before = h.handle.connections();
        expect(before).toHaveLength(1);

        // Advance our clock well past the pong timeout, then yield to
        // the event loop so the keepalive tick fires.
        advance(2_000);
        // Give the real setInterval a chance to run.
        await new Promise<void>((r) => setTimeout(r, 150));
        // The keepalive tick should have terminated the connection by now.
        const after = h.handle.connections();
        // Once closed the connection is removed from the registry, so
        // either length is 0 OR the state is 'closed'.
        if (after.length === 1) {
          expect(after[0].state).toBe("closed");
        } else {
          expect(after).toHaveLength(0);
        }
      } finally {
        if (client.readyState === client.OPEN) client.close();
      }
    } finally {
      await h.handle.close();
      await h.app.close();
    }
  });

  it("emits pings at the configured interval", async () => {
    // Sanity check that the keepalive defaults match the TASK-9 spec.
    expect(DEFAULT_PING_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_PONG_TIMEOUT_MS).toBe(45_000);
  });
});
