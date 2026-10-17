/**
 * WebSocket auth + session verification integration tests (TASK-10).
 *
 * Boots a real Fastify + ws server in-process, wires the real
 * `buildAuthResolver`, and verifies that:
 *   - A callsign claim goes through the full repo flow and returns
 *     `auth_ok` with `tokenExpiresAt`.
 *   - Re-claiming an existing callsign fails with `unauthenticated` and
 *     a 1008 close (per spec: callsign re-claim is impossible forever).
 *   - A token-based resume against an existing session works.
 *   - A resumed connection's record shows `playerId` set.
 *   - Unauthenticated gameplay frames (sent *before* `auth`) get an
 *     `unauthenticated` error.
 *   - An invalid token gets `unauthenticated` + close 1008.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import { attachWs, type WsHandle, type WsHandleOptions } from "./ws.js";
import { buildAuthResolver } from "./auth/resolver.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import { createSqliteTestDb } from "./db/client.js";
import { createRepository } from "./db/repo.js";

const SECRET = "q".repeat(32);
const GALAXY_SEED = "WS-AUTH-TEST";
const GALAXY_STAR_COUNT = 32;

interface Harness {
  app: FastifyInstance;
  handle: WsHandle;
  url: string;
  repo: ReturnType<typeof createRepository>;
  close: () => Promise<void>;
}

async function bootHarness(options: WsHandleOptions = {}): Promise<Harness> {
  const { db, close: closeDb } = createSqliteTestDb();
  const repo = createRepository({ driver: "sqlite", db });
  const app = Fastify({ logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const authResolver =
    options.authResolver ??
    buildAuthResolver(repo, SECRET, {
      galaxySeed: GALAXY_SEED,
      galaxyStarCount: GALAXY_STAR_COUNT,
    });
  const handle = attachWs(app, "/ws", { ...options, authResolver });
  return {
    app,
    handle,
    url: `ws://127.0.0.1:${port}/ws`,
    repo,
    close: async () => {
      await handle.close();
      await app.close();
      closeDb();
    },
  };
}

function openClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

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
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

function waitForClose(ws: WsClient, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reasonBuf) });
    });
  });
}

/**
 * Drive a `client` through hello → auth into the joined state. When
 * `callsign` is supplied it is used verbatim so two tests in the same
 * suite can intentionally collide; otherwise a fresh callsign is
 * generated.
 */
async function reachJoined(client: WsClient, callsign?: string): Promise<void> {
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await collectMessages(client, 1);
  const final = callsign ?? `WS-${Math.random().toString(36).slice(2, 6)}`;
  client.send(encodeEnvelope("auth", { callsign: final }));
  await collectMessages(client, 1);
}

describe("WS auth (TASK-10)", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await bootHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("claims a callsign through the WS handshake", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      const [helloAck] = await collectMessages(client, 1);
      expect(JSON.parse(helloAck).type).toBe("hello");

      const callsign = `T1-${Math.random().toString(36).slice(2, 6)}`;
      client.send(encodeEnvelope("auth", { callsign }));
      const [authAckRaw] = await collectMessages(client, 1);
      const authAck = JSON.parse(authAckRaw) as {
        type: string;
        payload: {
          playerId: string;
          callsign: string;
          tokenExpiresAt: number;
        };
      };
      expect(authAck.type).toBe("auth_ok");
      expect(authAck.payload.callsign).toBe(callsign);
      expect(authAck.payload.playerId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(authAck.payload.tokenExpiresAt).toBeGreaterThan(0);
      // Connection state should be 'joined' post-handshake.
      const conns = harness.handle.connections();
      expect(conns).toHaveLength(1);
      expect(conns[0]?.state).toBe("joined");
      expect(conns[0]?.callsign).toBe(callsign);
    } finally {
      client.close();
    }
  });

  it("rejects a duplicate callsign as unauthenticated", async () => {
    const callsign = `DUP-${Math.random().toString(36).slice(2, 6)}`;
    // First claim succeeds.
    {
      const client = await openClient(harness.url);
      try {
        await reachJoined(client, callsign);
      } finally {
        client.close();
      }
    }
    // Second claim rejects.
    {
      const client = await openClient(harness.url);
      try {
        client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
        await collectMessages(client, 1);
        client.send(encodeEnvelope("auth", { callsign }));
        const [errRaw] = await collectMessages(client, 1);
        const err = JSON.parse(errRaw) as { type: string; payload: { code: string } };
        expect(err.type).toBe("error");
        expect(err.payload.code).toBe("unauthenticated");
        const close = await waitForClose(client);
        expect(close.code).toBe(1008);
      } finally {
        if (client.readyState === client.OPEN) client.close();
      }
    }
  });

  it("rejects an unknown token with unauthenticated", async () => {
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      await collectMessages(client, 1);
      // Schema-validates `{token:string}`; a non-empty but bogus token
      // should resolve through the auth resolver, fail verification, and
      // surface as `unauthenticated`.
      const { mintToken } = await import("./auth/token.js");
      const { token } = mintToken("q".repeat(32), { playerId: "p-bogus" });
      // No session row exists for the hash of this token.
      client.send(encodeEnvelope("auth", { token }));
      const [errRaw] = await collectMessages(client, 1);
      const err = JSON.parse(errRaw) as { type: string; payload: { code: string } };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("unauthenticated");
      const close = await waitForClose(client);
      expect(close.code).toBe(1008);
    } finally {
      if (client.readyState === client.OPEN) client.close();
    }
  });

  it("out-of-order handshake frame is rejected with unauthenticated (no close)", async () => {
    const client = await openClient(harness.url);
    try {
      // Send `chat` before hello — should yield 'unauthenticated' but
      // server must NOT close (state-machine preserves idempotent ping/pong).
      client.send(encodeEnvelope("chat", { text: "ping" }));
      const [errRaw] = await collectMessages(client, 1);
      const err = JSON.parse(errRaw) as { type: string; payload: { code: string } };
      expect(err.type).toBe("error");
      expect(err.payload.code).toBe("unauthenticated");
      // Now finish the handshake.
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      const [helloAck] = await collectMessages(client, 1);
      expect(JSON.parse(helloAck).type).toBe("hello");
    } finally {
      client.close();
    }
  });

  it("resumes a session via a previously-issued token (server-side helper)", async () => {
    // Hand-craft a session row + token, then exercise the resume branch.
    const { mintToken } = await import("./auth/token.js");
    const { hashToken } = await import("./auth/token.js");
    const SECRET_LOCAL = "q".repeat(32);
    // Create a player first.
    const player = await harness.repo.createPlayer({
      callsign: `Resume-${Math.random().toString(36).slice(2, 6)}`,
      homeSystemId: "system-001",
    });
    const { token } = mintToken(SECRET_LOCAL, { playerId: player.id });
    await harness.repo.createSession({
      tokenHash: hashToken(token),
      playerId: player.id,
      ttlMs: 60_000,
    });
    const client = await openClient(harness.url);
    try {
      client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      await collectMessages(client, 1);
      client.send(encodeEnvelope("auth", { token }));
      const [authAckRaw] = await collectMessages(client, 1);
      const authAck = JSON.parse(authAckRaw) as { type: string; payload: { playerId: string } };
      expect(authAck.type).toBe("auth_ok");
      expect(authAck.payload.playerId).toBe(player.id);
    } finally {
      client.close();
    }
    void SECRET_LOCAL;
  });
});
