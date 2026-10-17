/**
 * Flood benchmark + drop verification (TASK-65 acceptance).
 *
 * Boots a real Fastify + WebSocket server with the rate-limit gate
 * active and runs a focused benchmark:
 *
 *   1. Sixteen "benign" clients stream inputs at a steady ~10 Hz and we
 *      measure their per-message round-trip latency — this asserts that
 *      the rate-limit gate does NOT add overhead to legitimate traffic.
 *      p95 must stay under 30 ms (the same budget the future server
 *      tick at TASK-13/60 will need to honour).
 *   2. One "attacker" connection then floods 100 msg/s synchronously,
 *      i.e. as fast as the WebSocket library will let it. The attacker
 *      must end up closed with WS code 4009 + reason `flooded` within
 *      ~5 s of starting the flood (in practice much sooner — the
 *      bucket empties within the first 40 sends).
 *
 * The benchmark is structured as two cases so a regression in either
 * path (legitimate traffic latency OR flood escalation) shows up as a
 * targeted failure rather than a flaky timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import Fastify, { type FastifyInstance } from "fastify";

import { attachWs, type WsHandle, type WsHandleOptions } from "./ws.js";
import { FLOOD_CLOSE_CODE, GENERAL_BURST } from "./ratelimit.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  handle: WsHandle;
  port: number;
  url: string;
}

async function bootHarness(options: WsHandleOptions = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const handle = attachWs(app, "/ws", options);
  return { app, handle, port, url: `ws://127.0.0.1:${port}/ws` };
}

function openClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws: WsClient, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString("utf8") });
    });
  });
}

/** Collect the next `n` text frames off `ws` within `timeoutMs`. */
function collectPongs(
  _harness: Harness,
  ws: WsClient,
  n: number,
  timeoutMs = 2000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${n} messages; got ${out.length}`));
    }, timeoutMs);
    const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Buffer.from(raw).toString("utf8");
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

async function reachJoined(client: WsClient, callsign: string): Promise<void> {
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await new Promise<void>((r) => setTimeout(r, 30));
  client.send(encodeEnvelope("auth", { callsign }));
  await new Promise<void>((r) => setTimeout(r, 30));
  client.send(encodeEnvelope("join_system", { systemId: "system-FLOOD" }));
  await new Promise<void>((r) => setTimeout(r, 30));
}

function inputFrame(seq: number): string {
  return encodeEnvelope("input", {
    seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    action: null,
  });
}

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return sorted[idx]!;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

describe("ws/ratelimit flood benchmark (TASK-65 acceptance)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });
  afterAll(async () => {
    await harness.handle.close();
    await harness.app.close();
  });

  it("keeps p95 per-message processing budget under 30 ms while 16 benign clients stream inputs", async () => {
    // Spawn 16 clients, drive each through the handshake, then sample
    // round-trip latency for a steady stream of pings at ~10 Hz. Each
    // sample measures wall-time around the send so the budget includes
    // socket send + server dispatch + receipt of the pong reply.
    const clients: WsClient[] = [];
    const samples: number[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        const c = await openClient(harness.url);
        clients.push(c);
        await reachJoined(c, `BENIGN-${i}`);
      }

      // Send 5 ping frames at ~10 Hz on each client, measuring how
      // long the round-trip takes. 5 rounds × 16 clients = 80 samples.
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 16; i++) {
          const c = clients[i]!;
          const t0 = performance.now();
          c.send(encodeEnvelope("ping", { t: round }));
          // Wait for the pong to come back.
          await new Promise<void>((resolve) => {
            const onMsg = (raw: Buffer | ArrayBuffer | Buffer[]): void => {
              const text = Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : Buffer.from(raw).toString("utf8");
              const parsed = JSON.parse(text) as { type: string; payload: { t: number } };
              if (parsed.type === "pong" && parsed.payload.t === round) {
                c.off("message", onMsg);
                resolve();
              }
            };
            c.on("message", onMsg);
          });
          const t1 = performance.now();
          samples.push(t1 - t0);
        }
        // Pace the send at ~10 Hz so we don't saturate the bucket.
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      const limit95 = p95(samples);
      expect(limit95).toBeLessThan(30);
    } finally {
      for (const c of clients) if (c.readyState === c.OPEN) c.close();
    }
  });

  it("drops a single flooding attacker with WS code 4009 + reason `flooded`", async () => {
    // Single attacker, no other connections active. Burst-send frames at
    // ~1000 msg/s; the bucket gate fires after GENERAL_BURST, the flood
    // tracker closes the connection after 3 violations.
    const attacker = await openClient(harness.url);
    try {
      await reachJoined(attacker, "FLOODER");

      const received: string[] = [];
      attacker.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw).toString("utf8");
        received.push(text);
      });
      const closePromise = waitForClose(attacker, 5_000);
      const start = performance.now();
      for (let i = 0; i < 80; i++) {
        attacker.send(inputFrame(i));
      }
      const close = await closePromise;
      const elapsedMs = performance.now() - start;
      expect(close.code).toBe(FLOOD_CLOSE_CODE);
      expect(close.reason).toBe("flooded");
      // The drop must happen well within 5 s of real time.
      expect(elapsedMs).toBeLessThan(5_000);
      const codes = received.map((r) => JSON.parse(r).payload?.code);
      expect(codes.filter((c) => c === "rate-limited").length).toBeGreaterThanOrEqual(3);
    } finally {
      if (attacker.readyState === attacker.OPEN) attacker.close();
    }
  });

  it("lets a normal-paced client survive indefinitely under the rate budget", async () => {
    // Sanity: a client below the rate limit must stay connected across
    // a steady send loop. We use ping frames at ~10 Hz (well under the
    // 20 msg/s budget) and run for ~30 frames to prove the connection
    // doesn't drop over time.
    const c = await openClient(harness.url);
    try {
      await reachJoined(c, "NORMAL");
      let pongCount = 0;
      c.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw).toString("utf8");
        const parsed = JSON.parse(text) as { type: string };
        if (parsed.type === "pong") pongCount += 1;
      });
      const FRAMES = 30;
      for (let i = 0; i < FRAMES; i++) {
        c.send(encodeEnvelope("ping", { t: i }));
        // 10 Hz — yield to the event loop to let pongs be processed.
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      // Connection still alive.
      const live = harness.handle.connections().find((conn) => conn.callsign === "NORMAL");
      expect(live).toBeDefined();
      expect(live?.state).not.toBe("closed");
      // Most if not all of our 30 pings were ack'd.
      expect(pongCount).toBeGreaterThanOrEqual(FRAMES - 2);
    } finally {
      if (c.readyState === c.OPEN) c.close();
    }
  });

  it("demonstrates the burst capacity by accepting GENERAL_BURST pings in flight", async () => {
    // Sanity / smoke: a single burst of GENERAL_BURST ping frames must
    // all be ack'd with pongs before any rate-limited frame appears.
    // We refill the bucket back to its burst cap (the handshake spent
    // 3 tokens) before the burst to keep the assertion strict.
    const c = await openClient(harness.url);
    try {
      await reachJoined(c, "BURST");
      // Refill: rate = 20 tokens/s ⇒ 50 ms per token, 250 ms ≈ 5 tokens
      // earned, capped at burst=40.
      await new Promise<void>((r) => setTimeout(r, 250));
      const collector = collectPongs(harness, c, GENERAL_BURST, 2_000);

      for (let i = 0; i < GENERAL_BURST; i++) {
        c.send(encodeEnvelope("ping", { t: i }));
      }
      const raws = await collector;
      let pongReply = 0;
      for (const raw of raws) {
        const parsed = JSON.parse(raw) as { type: string };
        if (parsed.type === "pong") pongReply += 1;
      }
      expect(pongReply).toBe(GENERAL_BURST);
    } finally {
      if (c.readyState === c.OPEN) c.close();
    }
  });
});
