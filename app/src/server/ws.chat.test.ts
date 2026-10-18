/**
 * WS integration tests for the system-wide chat pipeline (TASK-16).
 *
 * Boots a real Fastify + WebSocket server in-process and drives it
 * with real `ws` clients. Covers:
 *
 *   - **Echo**: 2 clients in the same shard both receive every
 *     message they send (sender echo included).
 *   - **Order**: 3 messages from one client arrive at the other in
 *     monotonic-ts order.
 *   - **Rate limit**: the 6th message within 10 s is dropped with a
 *     structured `rate-limited` error; the 5 prior messages survive.
 *   - **Validation**: empty / too-long / non-string inputs are
 *     rejected with `invalid-message`.
 *   - **Sanitization**: control bytes survive parse (the wire
 *     schema accepts them) but the broadcast carries the
 *     sanitized form (control → space, whitespace collapsed).
 *
 * The harness boots a real WS server with a minimal in-memory shard
 * so the broadcast loop has somewhere to write. The shard's `send`
 * hook writes directly to the live WebSocket via the connection
 * registry, bypassing the router so we don't have to spin up the DB
 * just to test chat.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import { collect } from "./ws.ratelimit-helpers.js";
import { attachWs, type WsHandle } from "./ws.js";
import type { Connection } from "./ws.connection.js";
import { ChatRingBuffer } from "./chat.js";

// ---------------------------------------------------------------------------
// Minimal in-memory shard for chat tests
// ---------------------------------------------------------------------------

interface MinimalShard {
  systemId: string;
  connections: Map<string, { connId: string }>;
  chatLog: ChatRingBuffer;
  send: (connId: string, frame: { type: string; payload: unknown }) => void;
}

function makeChatShard(registry: { values: () => IterableIterator<Connection> }): MinimalShard {
  const connections = new Map<string, { connId: string }>();
  const chatLog = new ChatRingBuffer();
  // The shard tracks connections in `connections` so the broadcast
  // loop has a recipient list; the `send` hook writes directly to
  // the matching WebSocket via the registry.
  const send = (connId: string, frame: { type: string; payload: unknown }): void => {
    for (const c of registry.values()) {
      if (c.connId !== connId) continue;
      try {
        c.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      } catch {
        // ignore — socket may already be closed
      }
    }
  };
  return {
    systemId: "chat-test-system",
    connections,
    chatLog,
    send,
  };
}

interface ChatHarness {
  app: FastifyInstance;
  handle: WsHandle;
  shard: MinimalShard;
  url: string;
}

async function bootChatHarness(): Promise<ChatHarness> {
  const app = Fastify({ logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);

  // eslint-disable-next-line prefer-const -- assigned in the joinResolver closure before use; ESLint can't follow the path.
  let shard!: MinimalShard;

  const handle = attachWs(app, "/ws", {
    joinResolver: async (_systemId, _callsign, connId) => {
      // Register the connection in the shard so broadcastChat has
      // a recipient. In production the router does this inside
      // `joinSystem`.
      if (!shard.connections.has(connId)) {
        shard.connections.set(connId, { connId });
      }
      return {
        systemId: "chat-test-system",
        entities: [],
        nodes: [],
        chat: shard.chatLog.snapshot(),
        players: [],
        serverTickHz: 20,
        snapshotTick: 0,
      };
    },
  });

  shard = makeChatShard(handle.registry);

  handle.setShardFor((conn) => {
    if (conn.systemId === null) return undefined;
    // Cast: the chat pipeline only reads the three fields we
    // expose; the shard helper in production uses the real
    // `Shard` type. Connection registration is handled by the
    // joinResolver (mirrors the router's behavior in production).
    return shard as unknown as Parameters<typeof handle.setShardFor>[0] extends (
      c: Connection,
    ) => infer R
      ? R
      : never;
  });

  handle.setOnConnectionClose((conn) => {
    shard.connections.delete(conn.connId);
  });

  return { app, handle, shard, url: `ws://127.0.0.1:${port}/ws` };
}

async function reachJoined(client: WsClient, callsign: string): Promise<void> {
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await collect(client, 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await collect(client, 1);
  client.send(encodeEnvelope("join_system", { systemId: "chat-test-system" }));
  await collect(client, 1);
}

/**
 * Open a client and resolve once `open` fires.
 */
function openClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Chat frame parsing
// ---------------------------------------------------------------------------

interface ChatFrame {
  type: "chat";
  payload: { id: string; author: string; text: string; ts: number };
}

interface ErrorFrame {
  type: "error";
  payload: { code: string; message: string };
}

function isChatFrame(raw: string): ChatFrame | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed.type !== "chat") return null;
    return parsed as ChatFrame;
  } catch {
    return null;
  }
}

function isErrorFrame(raw: string): ErrorFrame | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed.type !== "error") return null;
    return parsed as ErrorFrame;
  } catch {
    return null;
  }
}

/**
 * Wait for the next frame on `client` matching `predicate`.
 */
function waitForFrame(
  client: WsClient,
  predicate: (raw: string) => boolean,
  timeoutMs = 2000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data).toString("utf8");
      if (predicate(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onError = (): void => {
      cleanup();
      resolve(null);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("message", onMessage);
      client.off("error", onError);
    };
    client.on("message", onMessage);
    client.on("error", onError);
  });
}

async function waitForChat(client: WsClient, timeoutMs = 2000): Promise<ChatFrame | null> {
  const raw = await waitForFrame(client, (r) => isChatFrame(r) !== null, timeoutMs);
  return raw ? isChatFrame(raw) : null;
}

async function waitForError(client: WsClient, timeoutMs = 2000): Promise<ErrorFrame | null> {
  const raw = await waitForFrame(client, (r) => isErrorFrame(r) !== null, timeoutMs);
  return raw ? isErrorFrame(raw) : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ws/chat (TASK-16)", () => {
  let harness: ChatHarness;

  beforeAll(async () => {
    harness = await bootChatHarness();
  });
  afterAll(async () => {
    await harness.handle.close();
    await harness.app.close();
  });

  it("broadcasts a chat message to every client in the shard (including sender)", async () => {
    const alice = await openClient(harness.url);
    const bob = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-CHAT");
      await reachJoined(bob, "BOB-CHAT");

      alice.send(encodeEnvelope("chat", { text: "hello world" }));

      const aliceFrame = await waitForChat(alice, 2000);
      const bobFrame = await waitForChat(bob, 2000);
      expect(aliceFrame).not.toBeNull();
      expect(bobFrame).not.toBeNull();
      expect(aliceFrame!.payload.author).toBe("ALICE-CHAT");
      expect(aliceFrame!.payload.text).toBe("hello world");
      expect(aliceFrame!.payload.id).toMatch(/^chat-/);
      // Both frames carry the same id (server-broadcast).
      expect(aliceFrame!.payload.id).toBe(bobFrame!.payload.id);
      expect(typeof aliceFrame!.payload.ts).toBe("number");
      expect(aliceFrame!.payload.ts).toBeGreaterThan(0);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it("delivers 3 messages from one client in monotonic-ts order", async () => {
    const alice = await openClient(harness.url);
    const bob = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-ORDER");
      await reachJoined(bob, "BOB-ORDER");

      // Capture the next 3 chat frames on Bob.
      const received: ChatFrame[] = [];
      const collector = (data: Buffer | ArrayBuffer | Buffer[]): void => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data).toString("utf8");
        const f = isChatFrame(text);
        if (f) received.push(f);
      };
      bob.on("message", collector);

      alice.send(encodeEnvelope("chat", { text: "one" }));
      alice.send(encodeEnvelope("chat", { text: "two" }));
      alice.send(encodeEnvelope("chat", { text: "three" }));

      // Wait until we have 3 frames.
      const start = Date.now();
      while (received.length < 3 && Date.now() - start < 3000) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      bob.off("message", collector);

      expect(received.length).toBe(3);
      const ts0 = received[0]!.payload.ts;
      const ts1 = received[1]!.payload.ts;
      const ts2 = received[2]!.payload.ts;
      expect(ts1).toBeGreaterThanOrEqual(ts0);
      expect(ts2).toBeGreaterThanOrEqual(ts1);
      expect(received.map((r) => r.payload.text)).toEqual(["one", "two", "three"]);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it("drops the 6th chat within the 10s window with rate-limited", async () => {
    const alice = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-RATE");

      const received: ChatFrame[] = [];
      const errors: ErrorFrame[] = [];
      const onAny = (data: Buffer | ArrayBuffer | Buffer[]): void => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data).toString("utf8");
        const c = isChatFrame(text);
        if (c) received.push(c);
        const e = isErrorFrame(text);
        if (e) errors.push(e);
      };
      alice.on("message", onAny);

      for (let i = 0; i < 6; i++) {
        alice.send(encodeEnvelope("chat", { text: `msg-${i}` }));
      }

      // Wait until we have 5 chat frames + 1 error.
      const start = Date.now();
      while ((received.length < 5 || errors.length < 1) && Date.now() - start < 3000) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      alice.off("message", onAny);

      expect(received.length).toBe(5);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]!.payload.code).toBe("rate-limited");
      expect(errors[0]!.payload.message).toMatch(/chat rate exceeded/);
    } finally {
      alice.close();
    }
  });

  it("rejects empty text with invalid-message", async () => {
    const alice = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-EMPTY");
      alice.send(encodeEnvelope("chat", { text: "" }));
      const err = await waitForError(alice, 2000);
      expect(err).not.toBeNull();
      expect(err!.payload.code).toBe("invalid-message");
    } finally {
      alice.close();
    }
  });

  it("rejects text longer than the 200-char post-trim cap with invalid-message", async () => {
    const alice = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-LONG");
      alice.send(encodeEnvelope("chat", { text: "x".repeat(250) }));
      const err = await waitForError(alice, 2000);
      expect(err).not.toBeNull();
      expect(err!.payload.code).toBe("invalid-message");
    } finally {
      alice.close();
    }
  });

  it("rejects non-string chat.text with invalid-message", async () => {
    const alice = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-NS");
      // Bypass the envelope helper so we can send a non-string text
      // (the wire schema would reject it as `invalid-message` anyway;
      // this verifies our explicit validation step also rejects).
      alice.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat", payload: { text: 42 } }));
      const err = await waitForError(alice, 2000);
      expect(err).not.toBeNull();
      expect(err!.payload.code).toBe("invalid-message");
    } finally {
      alice.close();
    }
  });

  it("sanitizes control bytes before broadcasting", async () => {
    const alice = await openClient(harness.url);
    const bob = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-CLEAN");
      await reachJoined(bob, "BOB-CLEAN");

      // Send a message with control bytes (NUL + tab + NUL).
      alice.send(encodeEnvelope("chat", { text: "a\u0000b\tc" }));

      const bobFrame = await waitForChat(bob, 2000);
      expect(bobFrame).not.toBeNull();
      // Sanitized to whitespace-collapsed form (control → space,
      // runs collapsed).
      expect(bobFrame!.payload.text).toBe("a b c");
    } finally {
      alice.close();
      bob.close();
    }
  });

  it("leaves XSS payloads as inert text on the wire (no HTML injection)", async () => {
    const alice = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-XSS");
      alice.send(encodeEnvelope("chat", { text: "<img src=x onerror=alert(1)>" }));
      const f = await waitForChat(alice, 2000);
      expect(f).not.toBeNull();
      // Server kept the angle brackets — React's auto-escape handles
      // the rest at render time. The chat log has no HTML parser
      // path so the payload can never execute.
      expect(f!.payload.text).toBe("<img src=x onerror=alert(1)>");
    } finally {
      alice.close();
    }
  });

  it("seeds enter_system.chat with the shard's rolling history", async () => {
    // Three clients in order. The first two chat; the third joins
    // and should see both messages in its `enter_system.chat`.
    const alice = await openClient(harness.url);
    const bob = await openClient(harness.url);
    const carol = await openClient(harness.url);
    try {
      await reachJoined(alice, "ALICE-HIST");
      await reachJoined(bob, "BOB-HIST");

      alice.send(encodeEnvelope("chat", { text: "first" }));
      await waitForChat(alice, 2000);
      alice.send(encodeEnvelope("chat", { text: "second" }));
      await waitForChat(alice, 2000);

      // Carol now joins and should see both messages in enter_system.
      carol.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
      await collect(carol, 1);
      carol.send(encodeEnvelope("auth", { callsign: "CAROL-HIST" }));
      await collect(carol, 1);
      carol.send(encodeEnvelope("join_system", { systemId: "chat-test-system" }));

      const enter = await waitForFrame(carol, (r) => r.includes(`"type":"enter_system"`), 2000);
      expect(enter).not.toBeNull();
      const parsed = JSON.parse(enter!) as {
        payload: { chat: Array<{ text: string; author: string }> };
      };
      expect(parsed.payload.chat.length).toBeGreaterThanOrEqual(2);
      const texts = parsed.payload.chat.map((c) => c.text);
      expect(texts).toContain("first");
      expect(texts).toContain("second");
    } finally {
      alice.close();
      bob.close();
      carol.close();
    }
  });
});
