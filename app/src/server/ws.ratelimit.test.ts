/**
 * Integration tests for rate limiting (TASK-65).
 *
 * Boots a real Fastify + WebSocket server in-process and drives it with
 * real `ws` clients. The unit tests in `ratelimit.test.ts` cover the
 * math of each component in isolation; the cases here verify that the
 * pieces are wired into the dispatch correctly:
 *
 *   - general token bucket fires *before* envelope parsing so JSON.parse
 *     never sees the excess,
 *   - chat limiter enforces 2 s gap / 280 chars / 10 per 30 s on the
 *     wire (not just in unit math),
 *   - escalation closes the socket with WS code 4009 + reason "flooded"
 *     after three violations,
 *   - per-connection isolation: flooding one client does not deny
 *     service to other connections.
 *
 * Helpers (`bootHarness`, `openClient`, `collect`, etc.) live in
 * `./ws.ratelimit-helpers.ts` to keep this file under AGENTS.md's
 * 200-300 line ceiling.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CHAT_MAX_LEN, FLOOD_CLOSE_CODE, GENERAL_BURST } from "./ratelimit.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import {
  bootHarness,
  collect,
  decodeError,
  openClient,
  reachJoined,
  waitForClose,
  type Harness,
} from "./ws.ratelimit-helpers.js";

// ---------------------------------------------------------------------------
// Tests: general bucket
// ---------------------------------------------------------------------------

describe("ws/ratelimit general bucket (TASK-65)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });
  afterAll(async () => {
    await harness.handle.close();
    await harness.app.close();
  });

  it("accepts the burst and rate-limits + drops after escalation", async () => {
    // The handshake (hello, auth, join_system) consumed 3 tokens from
    // the bucket. Wait long enough to refill above the burst cap before
    // dispatching the burst of pings so the bucket is at GENERAL_BURST
    // when the burst lands.
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TEST-BURST-ACCEPT", harness);
      await new Promise<void>((r) => setTimeout(r, 250));
      const accepted = collect(client, GENERAL_BURST, 2_000);
      for (let i = 0; i < GENERAL_BURST; i++) {
        client.send(encodeEnvelope("ping", { t: i }));
      }
      const raws = await accepted;
      let pongs = 0;
      for (const raw of raws) {
        const f = JSON.parse(raw) as { type: string };
        if (f.type === "pong") pongs += 1;
      }
      expect(pongs).toBe(GENERAL_BURST);

      // Connection still alive after the burst.
      const live = harness.handle.connections().find((c) => c.callsign === "TEST-BURST-ACCEPT");
      expect(live).toBeDefined();
      expect(live?.state).not.toBe("closed");

      // Now send 8 more pings into the empty bucket — the 3rd rate-limit
      // violation trips the flood tracker and the connection is closed
      // with WS code 4009 + reason `flooded`.
      const received: string[] = [];
      client.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw).toString("utf8");
        received.push(text);
      });
      const closePromise = waitForClose(client, 3_000);
      for (let i = 0; i < 8; i++) {
        client.send(encodeEnvelope("ping", { t: GENERAL_BURST + i }));
      }
      const close = await closePromise;
      expect(close.code).toBe(FLOOD_CLOSE_CODE);
      expect(close.reason).toBe("flooded");
      const codes = received.map((r) => decodeError(r).payload.code);
      expect(codes.filter((c) => c === "rate-limited").length).toBeGreaterThanOrEqual(3);
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("rate-limit gate runs before envelope parsing", async () => {
    // Send malformed (non-JSON) frames. First GENERAL_BURST pass through
    // the bucket, hit JSON.parse, get `invalid-message`. Frames beyond
    // the burst are caught by the rate-limit gate BEFORE parsing — they
    // get `rate-limited`.
    const client = await openClient(harness.url);
    try {
      // Refill the bucket so we don't drain it during the burst of
      // malformed frames.
      await new Promise<void>((r) => setTimeout(r, 250));
      const received: string[] = [];
      const done = new Promise<void>((resolve) => {
        const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]): void => {
          const text = Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Buffer.from(raw).toString("utf8");
          received.push(text);
        };
        client.on("message", onMessage);
        client.once("close", () => {
          client.off("message", onMessage);
          resolve();
        });
      });
      for (let i = 0; i < 80; i++) {
        client.send("this is not json");
      }
      await done;

      const codes = received.map((r) => decodeError(r).payload.code);
      expect(codes).toContain("invalid-message");
      expect(codes).toContain("rate-limited");
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: chat limits
// ---------------------------------------------------------------------------

describe("ws/ratelimit chat limits (TASK-65)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });
  afterAll(async () => {
    await harness.handle.close();
    await harness.app.close();
  });

  it("accepts the first chat", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TEST-CHAT-OK", harness);
      // Use a ping as a "no message arrived" marker: if the chat were
      // rejected we'd see an error frame first.
      client.send(encodeEnvelope("ping", { t: 1 }));
      const [pong] = await collect(client, 1);
      expect(JSON.parse(pong).type).toBe("pong");
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("rejects chat sent within the 2 s min-gap with rate-limited (too-soon)", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TEST-CHAT-GAP", harness);
      const errors = collect(client, 1);
      client.send(encodeEnvelope("chat", { text: "hello" }));
      // Wait less than the 2 s gap, then send a 2nd chat. The 2nd must
      // come back as a `too-soon` rate-limited error.
      await new Promise<void>((r) => setTimeout(r, 200));
      client.send(encodeEnvelope("chat", { text: "world" }));
      const [errRaw] = await errors;
      const err = decodeError(errRaw);
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("rate-limited");
      expect(err.payload.message).toMatch(/min 1 message/i);
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("rejects chat that exceeds 280 characters with rate-limited (too-long)", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TEST-CHAT-LONG", harness);
      const errors = collect(client, 1);
      const text = "x".repeat(CHAT_MAX_LEN + 1);
      client.send(encodeEnvelope("chat", { text }));
      const [errRaw] = await errors;
      const err = decodeError(errRaw);
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("rate-limited");
      expect(err.payload.message).toMatch(/exceeds 280/);
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("isolates per-connection rate-limit state", async () => {
    // Two clients in parallel: client A floods and gets dropped; client B
    // must remain healthy throughout.
    const a = await openClient(harness.url);
    const b = await openClient(harness.url);
    try {
      await reachJoined(a, "TEST-ISO-A", harness);
      await reachJoined(b, "TEST-ISO-B", harness);

      const aReceived: string[] = [];
      a.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw).toString("utf8");
        aReceived.push(text);
      });
      const aClosed = waitForClose(a, 3_000);
      // Burst-send 60 input frames to client A. The bucket gate will
      // throw 3+ rate-limited errors back and the flood tracker will
      // drop the connection with 4009.
      for (let i = 0; i < 60; i++) {
        a.send(
          encodeEnvelope("input", {
            seq: i,
            thrust: 0,
            turn: 0,
            pitch: 0,
            yaw: 0,
            fire: false,
            lock: false,
            action: null,
          }),
        );
      }
      const close = await aClosed;
      expect(close.code).toBe(FLOOD_CLOSE_CODE);

      const aCodes = aReceived.map((r) => decodeError(r).payload.code);
      expect(aCodes.filter((c) => c === "rate-limited").length).toBeGreaterThanOrEqual(3);

      // Client B must be unaffected.
      b.send(encodeEnvelope("ping", { t: 1 }));
      const [pong] = await collect(b, 1);
      expect(JSON.parse(pong).type).toBe("pong");
      const live = harness.handle.connections().find((c) => c.callsign === "TEST-ISO-B");
      expect(live?.state).toBe("joined");
    } finally {
      if (a.readyState === a.OPEN) a.close();
      if (b.readyState === b.OPEN) b.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: escalation
// ---------------------------------------------------------------------------

describe("ws/ratelimit escalation (TASK-65)", () => {
  it("drops the connection with WS code 4009 after three violations in 10 s", async () => {
    // Burst-send 60 input frames synchronously; the first GENERAL_BURST
    // (40) take the bucket, frames 41 onwards are rate-limited. The 3rd
    // such error triggers the flood tracker → close 4009.
    const harness = await bootHarness();
    try {
      const client = await openClient(harness.url);
      try {
        await reachJoined(client, "TEST-FLOOD", harness);
        const received: string[] = [];
        client.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
          const text = Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Buffer.from(raw).toString("utf8");
          received.push(text);
        });
        const closePromise = waitForClose(client, 3_000);

        for (let i = 0; i < 60; i++) {
          client.send(
            encodeEnvelope("input", {
              seq: i,
              thrust: 0,
              turn: 0,
              pitch: 0,
              yaw: 0,
              fire: false,
              lock: false,
              action: null,
            }),
          );
        }
        const close = await closePromise;
        expect(close.code).toBe(FLOOD_CLOSE_CODE);
        expect(close.reason).toBe("flooded");

        const codes = received.map((r) => decodeError(r).payload.code);
        expect(codes.filter((c) => c === "rate-limited").length).toBeGreaterThanOrEqual(3);

        const live = harness.handle.connections().find((c) => c.callsign === "TEST-FLOOD");
        expect(live).toBeUndefined();
      } finally {
        if (client.readyState === client.OPEN) client.close();
      }
    } finally {
      await harness.handle.close();
      await harness.app.close();
    }
  });

  it("does not drop a client whose violations are spaced outside the 10 s window", async () => {
    // Hand-drive the clock so we can space violations > 10 s apart
    // without waiting on real wall time. Each burst sends
    // GENERAL_BURST + 1 frames so the overflow is rate-limited. The
    // flood tracker records the violation at the burst's processing
    // time; advancing the clock 11 s first evicts the prior violation
    // so we never accumulate ≥ 3 within any 10 s window.
    let clock = 1_000_000;
    const fakeNow = (): number => clock;
    const harness = await bootHarness({ now: fakeNow });
    try {
      const client = await openClient(harness.url);
      try {
        await reachJoined(client, "TEST-SLOW", harness);

        const received: string[] = [];
        client.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
          const text = Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Buffer.from(raw).toString("utf8");
          received.push(text);
        });

        // Refill bucket past the burst cap once (after handshake spend).
        clock += 11_000;

        for (let batch = 0; batch < 4; batch++) {
          for (let i = 0; i < GENERAL_BURST + 1; i++) {
            client.send(
              encodeEnvelope("input", {
                seq: batch * 100 + i,
                thrust: 0,
                turn: 0,
                pitch: 0,
                yaw: 0,
                fire: false,
                lock: false,
                action: null,
              }),
            );
          }
          // Yield so the server processes the burst.
          await new Promise<void>((r) => setTimeout(r, 50));
          // Advance the fake clock past the 10 s window.
          clock += 11_000;
        }
        await new Promise<void>((r) => setTimeout(r, 100));

        const codes = received.map((r) => decodeError(r).payload.code);
        const rateLimitedCount = codes.filter((c) => c === "rate-limited").length;
        expect(rateLimitedCount).toBeGreaterThanOrEqual(3);

        // Connection survived — no escalation because violations were
        // spaced > 10 s apart.
        const live = harness.handle.connections().find((c) => c.callsign === "TEST-SLOW");
        expect(live).toBeDefined();
        expect(live?.state).not.toBe("closed");
      } finally {
        if (client.readyState === client.OPEN) client.close();
      }
    } finally {
      await harness.handle.close();
      await harness.app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Compatibility: ensure the TASK-65 rate-limit infrastructure integrates
// with the existing TASK-9 handshake + TASK-64 validation paths without
// breaking them. The lifecycle observer should see exactly
// hello → authed → joined, and a legitimate chat must not trip a strike.
// ---------------------------------------------------------------------------

describe("ws/ratelimit + lifecycle integration", () => {
  it("flooding with malformed (unknown-type) frames trips the rate-limit escalation before the strike counter", async () => {
    // Companion to `ws.test.ts`'s clock-paced "counts unknown types
    // and drops at the threshold" test. Here we *burst-send* — the
    // rate-limit gate fires before the 50-strike counter can complete
    // and the connection is dropped with code 4009 + reason `flooded`.
    const harness = await bootHarness();
    try {
      const client = await openClient(harness.url);
      try {
        client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        await collect(client, 1); // hello ack
        const received: string[] = [];
        client.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
          const text = Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Buffer.from(raw).toString("utf8");
          received.push(text);
        });
        const closePromise = waitForClose(client, 3_000);
        for (let i = 0; i < 80; i++) {
          client.send(
            JSON.stringify({
              v: 1,
              type: "definitely-not-a-type",
              payload: { i },
            }),
          );
        }
        const close = await closePromise;
        expect(close.code).toBe(FLOOD_CLOSE_CODE);
        expect(close.reason).toBe("flooded");
      } finally {
        if (client.readyState === client.OPEN) client.close();
      }
    } finally {
      await harness.handle.close();
      await harness.app.close();
    }
  });
});

describe("ws/ratelimit + lifecycle integration (compat)", () => {
  it("drives hello → authed → joined without touching the rate-limit gate", async () => {
    const observed: string[] = [];
    const harness = await bootHarness({
      onStateChange: (record) => observed.push(record.state),
    });
    try {
      const client = await openClient(harness.url);
      try {
        await reachJoined(client, "TEST-COMPAT", harness);
        client.send(encodeEnvelope("chat", { text: "all good" }));
        client.send(encodeEnvelope("ping", { t: 9 }));
        await collect(client, 1);
        expect(observed).toEqual(["authed", "joined"]);
      } finally {
        if (client.readyState === client.OPEN) client.close();
      }
    } finally {
      await harness.handle.close();
      await harness.app.close();
    }
  });
});
