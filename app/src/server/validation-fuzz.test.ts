/**
 * Fuzz test suite for inbound-message validation (TASK-64 acceptance).
 *
 * Boots a real Fastify + ws server in-process (no Playwright, no TCP
 * port leak) and fires 20 crafted malformed payloads at it. See
 * `./ws.fuzz-helpers.ts` for the payload catalogue + transport harness.
 *
 * Each malformed frame MUST:
 *   1. Receive a structured `error` frame with `{ code, message }`
 *      where `code` is `invalid-message` (or `unknown-type` for the
 *      one dedicated case below). The server MUST NOT echo the raw
 *      payload back to the client.
 *   2. Leave the connection alive so the test can drive a valid
 *      `hello` → `auth` flow afterwards.
 *
 * After the fuzz round:
 *   - `GET /api/health` still returns 200 (REST route untouched).
 *   - A fresh WebSocket can complete the full handshake.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import { INVALID_DROP_THRESHOLD } from "./ws.js";
import {
  bootFuzzHarness,
  openFuzzClient,
  collectFuzzMessages,
  type FuzzHarness,
} from "./ws.fuzz-helpers.js";
import { FUZZ_PAYLOADS, REQUIRED_FUZZ_NAMES, byteString } from "./ws.fuzz-payloads.js";

/** Decode an inbound error frame and assert on its shape. */
function expectErrorFrame(raw: string, expectedCode: string): { code: string; message: string } {
  const frame = JSON.parse(raw) as {
    type: string;
    payload: { code: string; message: string };
  };
  expect(frame.type).toBe("error");
  expect(frame.payload.code).toBe(expectedCode);
  expect(typeof frame.payload.message).toBe("string");
  expect(frame.payload.message.length).toBeGreaterThan(0);
  return { code: frame.payload.code, message: frame.payload.message };
}

describe("ws/validation-fuzz (TASK-64 acceptance)", () => {
  let harness: FuzzHarness;

  beforeAll(async () => {
    harness = await bootFuzzHarness();
  });

  afterAll(async () => {
    await harness.handle.close();
    await harness.app.close();
  });

  it("exposes 20+ crafted malformed payloads", () => {
    expect(FUZZ_PAYLOADS.length).toBeGreaterThanOrEqual(20);
    for (const f of FUZZ_PAYLOADS) {
      expect(typeof f.name).toBe("string");
      expect(typeof f.raw).toBe("string");
      expect(typeof f.expectCode).toBe("string");
      // Names should be unique so a CI failure points to a specific case.
      const dupes = FUZZ_PAYLOADS.filter((g) => g.name === f.name);
      expect(dupes.length).toBe(1);
    }
  });

  it("rejects every crafted malformed payload with structured invalid-message / unknown-type", async () => {
    // We use a single connection and send all 20 fuzz frames back-to-back.
    // None of them should close the connection (the strike counter would
    // have to reach INVALID_DROP_THRESHOLD=50 for that, which is far more
    // than 20). After the burst we drive a valid hello→auth flow on the
    // SAME socket to prove the connection survives.
    const client = await openFuzzClient(harness.url);
    try {
      const errors = collectFuzzMessages(client, FUZZ_PAYLOADS.length);
      for (const f of FUZZ_PAYLOADS) {
        client.send(f.raw);
      }
      const raws = await errors;
      expect(raws).toHaveLength(FUZZ_PAYLOADS.length);
      raws.forEach((raw, i) => {
        const f = FUZZ_PAYLOADS[i];
        const { code, message } = expectErrorFrame(raw, f.expectCode);
        expect(code).toBe(f.expectCode);
        // Sanity bound on the error message. The error schema enforces
        // max(500) characters; the message must stay inside that.
        expect(message.length).toBeLessThan(500);
        // For structured payloads where the server COULD be tempted to
        // echo content verbatim, make sure it doesn't — that would
        // defeat the purpose of structured errors per TASK-64.
        if (f.raw.length > 200) {
          expect(message.includes(f.raw)).toBe(false);
        }
      });

      // After the fuzz, drive a valid handshake on the same socket to
      // prove the connection survived the burst.
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      const [helloAck] = await collectFuzzMessages(client, 1);
      const ack = JSON.parse(helloAck) as { type: string; payload: { version: number } };
      expect(ack.type).toBe("hello");
      expect(ack.payload.version).toBe(PROTOCOL_VERSION);

      client.send(encodeEnvelope("auth", { callsign: "TEST-FUZZ" }));
      const [authAck] = await collectFuzzMessages(client, 1);
      const authOk = JSON.parse(authAck) as {
        type: string;
        payload: { callsign: string };
      };
      expect(authOk.type).toBe("auth_ok");
      expect(authOk.payload.callsign).toBe("TEST-FUZZ");

      // Strike counter records every fuzz-driven error.
      const conns = harness.handle.connections();
      const live = conns.find((c) => c.callsign === "TEST-FUZZ");
      expect(live?.invalidCount).toBe(FUZZ_PAYLOADS.length);
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("rejects 1 MB payloads with invalid-message and keeps the socket alive", async () => {
    // Distinct from the per-type fuzz above: this exercises the 64 KB
    // size gate, which fires *before* envelope parsing. The message
    // must reference the byte limit and the connection must stay alive.
    const client = await openFuzzClient(harness.url);
    const oneMb = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "chat",
      payload: { text: byteString(1024 * 1024) },
    });
    try {
      const errors = collectFuzzMessages(client, 1);
      client.send(oneMb);
      const [errRaw] = await errors;
      const { code, message } = expectErrorFrame(errRaw, "invalid-message");
      expect(code).toBe("invalid-message");
      expect(message).toMatch(/65536|byte limit/i);
      // Connection still alive: ping/pong round-trip succeeds.
      client.send(encodeEnvelope("ping", { t: 1 }));
      const [pongRaw] = await collectFuzzMessages(client, 1);
      expect(JSON.parse(pongRaw)).toEqual({
        v: PROTOCOL_VERSION,
        type: "pong",
        payload: { t: 1 },
      });
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("keeps /api/health answering 200 across the fuzz round", async () => {
    // Hammer health for good measure: a fuzz-bombed server should still
    // be answering its REST routes with 200 + a valid galaxySeed.
    for (let i = 0; i < 5; i++) {
      const response = await harness.app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { ok: boolean; galaxySeed: string };
      expect(body.ok).toBe(true);
      expect(body.galaxySeed.length).toBeGreaterThan(0);
    }
  });

  it("pins INVALID_DROP_THRESHOLD = 50 (TASK-64 acceptance)", () => {
    // Future tasks may tweak the threshold; this assertion forces the
    // change to be deliberate (and to land here).
    expect(INVALID_DROP_THRESHOLD).toBe(50);
  });

  it("covers the spec-required payload families", () => {
    const names = new Set(FUZZ_PAYLOADS.map((f) => f.name));
    for (const requiredName of REQUIRED_FUZZ_NAMES) {
      expect(names.has(requiredName), `missing fuzz case: ${requiredName}`).toBe(true);
    }
  });
});
