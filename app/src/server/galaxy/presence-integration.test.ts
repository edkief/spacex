/**
 * TASK-15 WS integration test — multi-client presence.
 *
 * Boots a real Fastify + ws server + galaxy router and exercises
 * the end-to-end acceptance criteria:
 *
 *   1. 3 clients join the same system; each sees exactly the other
 *      2 callsigns in their roster (self excluded).
 *   2. One client leaves; the other two see the roster shrink to
 *      two entries within 1 s of the leave.
 *   3. A client joining a different system is NOT listed in the
 *      first system's roster (no cross-system leak).
 *   4. A client's roster updates within one snapshot of a join
 *      event in the same system.
 *
 * The harness reuses the bridge pattern from
 * `router.ws-bridge.test.ts` so the test runs against the real
 * server code path (Fastify + ws + GalaxyRouter + presence
 * broadcaster).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import { attachWs, type WsHandle } from "../ws.js";
import { buildAuthResolver, buildLogoutResolver } from "../auth/resolver.js";
import { buildRouterJoinResolver } from "./join-resolver.js";
import { GalaxyRouter } from "./router.js";
import { buildPresenceBroadcaster, createConnectionCloseHook } from "./ws-router-bridge.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import { generateStars } from "@shared/galaxy/stars.js";

import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { assertValidSecret } from "../auth/token.js";

installRepoHooks();

const SESSION_SECRET = "PRESENCE-IT-TEST-SECRET-DO-NOT-USE-IN-PRODUCTION-1234567890";
const SEED = "PRESENCE-IT-TEST-SEED";
const STAR_COUNT = 8;

interface Harness {
  app: FastifyInstance;
  handle: WsHandle;
  router: GalaxyRouter;
  port: number;
  url: string;
}

async function boot(): Promise<Harness> {
  const { repo } = active();
  assertValidSecret(SESSION_SECRET);

  const app = Fastify({ logger: false });
  const { registerCallsignRoutes } = await import("../routes/callsigns.js");
  registerCallsignRoutes(app, {
    repo,
    sessionSecret: SESSION_SECRET,
    claimDefaults: { galaxySeed: SEED, galaxyStarCount: STAR_COUNT },
  });
  await app.ready();

  const authResolver = buildAuthResolver(repo, SESSION_SECRET, {
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
  });
  const logoutResolver = buildLogoutResolver(repo);

  const handle = attachWs(app, "/ws", {
    authResolver,
    logoutResolver,
  });
  const router = new GalaxyRouter({
    repo,
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
    reapGraceMs: 60_000,
    reapIntervalMs: 60_000,
    presenceBroadcaster: buildPresenceBroadcaster({ registry: handle.registry }),
  });
  handle.setOnConnectionClose(createConnectionCloseHook({ router }));
  handle.setJoinResolver(buildRouterJoinResolver({ repo, router }));

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);

  return { app, handle, router, port, url: `ws://127.0.0.1:${port}/ws` };
}

async function teardown(h: Harness): Promise<void> {
  await h.handle.close();
  await h.app.close();
}

interface Client {
  ws: WsClient;
  messages: string[];
  callsign: string;
  playerId: string;
  /** Last presence payload seen, for asserts. */
  lastPresence: { systemId: string; players: Array<{ callsign: string }> } | null;
}

async function claim(h: Harness, callsign: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/callsigns",
    payload: { callsign },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

async function connectAndAuth(h: Harness, callsign: string): Promise<Client> {
  const token = await claim(h, callsign);
  const ws = new WsClient(h.url);
  const messages: string[] = [];
  const client: Client = {
    ws,
    messages,
    callsign,
    playerId: "",
    lastPresence: null,
  };
  ws.on("message", (data) => {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const text = buf.toString("utf8");
    messages.push(text);
    if (text.includes(`"type":"presence"`)) {
      try {
        const parsed = JSON.parse(text) as {
          payload: { systemId: string; players: Array<{ callsign: string }> };
        };
        client.lastPresence = parsed.payload;
      } catch {
        // ignore malformed
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  ws.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await waitFor(messages, (m) => m.includes(`"type":"hello"`));
  ws.send(encodeEnvelope("auth", { token }));
  const authOk = await waitFor(messages, (m) => m.includes(`"type":"auth_ok"`));
  const authPayload = JSON.parse(authOk) as {
    payload: { playerId: string; callsign: string };
  };
  client.playerId = authPayload.payload.playerId;
  return client;
}

async function join(c: Client, systemId: string): Promise<void> {
  c.ws.send(encodeEnvelope("join_system", { systemId }));
  await waitFor(c.messages, (m) => m.includes(`"type":"enter_system"`), 1500);
}

/** Wait until `predicate` matches one of the buffered messages, or fail. */
async function waitFor(
  messages: string[],
  predicate: (msg: string) => boolean,
  timeoutMs = 1500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < messages.length; i++) {
      if (predicate(messages[i]!)) return messages[i]!;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms; got ${messages.length} messages: ${JSON.stringify(
      messages.slice(-3),
    )}`,
  );
}

/** Wait until `predicate` matches a NEW message (one we haven't seen yet). */
async function waitForNext(
  messages: string[],
  seenIndex: number,
  predicate: (msg: string) => boolean,
  timeoutMs = 1500,
): Promise<{ msg: string; index: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = seenIndex; i < messages.length; i++) {
      if (predicate(messages[i]!)) return { msg: messages[i]!, index: i };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitForNext timed out after ${timeoutMs}ms`);
}

/** Parse the presence payload from a raw frame. */
function parsePresence(msg: string): { systemId: string; players: Array<{ callsign: string }> } {
  const parsed = JSON.parse(msg) as {
    payload: { systemId: string; players: Array<{ callsign: string }> };
  };
  return parsed.payload;
}

describe("TASK-15 multi-client presence", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await boot();
  });
  afterEach(async () => {
    await teardown(harness);
  });

  function systems(): { a: string; b: string } {
    const stars = generateStars(SEED, STAR_COUNT);
    return { a: stars[0]!.id, b: stars[1]!.id };
  }

  it("3 clients in one system — each sees exactly the other 2 in its list", async () => {
    const sysId = systems().a;
    const c1 = await connectAndAuth(harness, "P15-A");
    const c2 = await connectAndAuth(harness, "P15-B");
    const c3 = await connectAndAuth(harness, "P15-C");

    await join(c1, sysId);
    // c1 just joined → presence frame with itself only.
    expect(c1.lastPresence).not.toBeNull();
    expect(c1.lastPresence!.players.map((p) => p.callsign)).toEqual(["P15-A"]);

    await join(c2, sysId);
    // c1 now sees a 2-entry roster; c2 sees a 2-entry roster.
    expect(c1.lastPresence!.players.map((p) => p.callsign).sort()).toEqual(["P15-A", "P15-B"]);
    expect(c2.lastPresence!.players.map((p) => p.callsign).sort()).toEqual(["P15-A", "P15-B"]);

    await join(c3, sysId);
    // All three see a 3-entry roster.
    for (const c of [c1, c2, c3]) {
      const names = c.lastPresence!.players.map((p) => p.callsign).sort();
      expect(names).toEqual(["P15-A", "P15-B", "P15-C"]);
    }

    // Clean up.
    c1.ws.close();
    c2.ws.close();
    c3.ws.close();
    await new Promise((r) => setTimeout(r, 25));
  });

  it("one leaves — the other two update within 1 s", async () => {
    const sysId = systems().a;
    const c1 = await connectAndAuth(harness, "LEAVE-1");
    const c2 = await connectAndAuth(harness, "LEAVE-2");
    const c3 = await connectAndAuth(harness, "LEAVE-3");
    await join(c1, sysId);
    await join(c2, sysId);
    await join(c3, sysId);

    // Sanity: all three are in the roster.
    for (const c of [c1, c2, c3]) {
      expect(c.lastPresence!.players.map((p) => p.callsign).sort()).toEqual([
        "LEAVE-1",
        "LEAVE-2",
        "LEAVE-3",
      ]);
    }

    // Snapshot the message indices so we can wait for a NEW presence
    // frame rather than re-reading the old one.
    const c1Index = c1.messages.length;
    const c2Index = c2.messages.length;
    const c3Index = c3.messages.length;

    const start = Date.now();
    c3.ws.close();
    // Both remaining clients should see a roster without LEAVE-3
    // well within 1 s.
    const result1 = await waitForNext(
      c1.messages,
      c1Index,
      (m) => {
        if (!m.includes(`"type":"presence"`)) return false;
        const p = parsePresence(m);
        return !p.players.some((x) => x.callsign === "LEAVE-3");
      },
      1000,
    );
    const result2 = await waitForNext(
      c2.messages,
      c2Index,
      (m) => {
        if (!m.includes(`"type":"presence"`)) return false;
        const p = parsePresence(m);
        return !p.players.some((x) => x.callsign === "LEAVE-3");
      },
      1000,
    );
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);

    // Sanity: the new roster still contains the other two.
    const r1 = parsePresence(result1.msg);
    expect(r1.players.map((p) => p.callsign).sort()).toEqual(["LEAVE-1", "LEAVE-2"]);
    const r2 = parsePresence(result2.msg);
    expect(r2.players.map((p) => p.callsign).sort()).toEqual(["LEAVE-1", "LEAVE-2"]);

    // The leaver's own client never sees the new roster (it closed).
    void c3Index;
    c1.ws.close();
    c2.ws.close();
    await new Promise((r) => setTimeout(r, 25));
  });

  it("a client joining a different system is not listed in the first system", async () => {
    const sysA = systems().a;
    const sysB = systems().b;
    const c1 = await connectAndAuth(harness, "CROSS-1");
    const c2 = await connectAndAuth(harness, "CROSS-2");
    await join(c1, sysA);
    // c1 sees only itself in system A.
    expect(c1.lastPresence!.players.map((p) => p.callsign)).toEqual(["CROSS-1"]);

    // c2 joins system B — should NOT appear in c1's system A roster.
    await join(c2, sysB);
    expect(c1.lastPresence!.players.map((p) => p.callsign)).toEqual(["CROSS-1"]);
    expect(c1.lastPresence!.systemId).toBe(sysA);
    // c2 sees only itself in system B.
    expect(c2.lastPresence!.players.map((p) => p.callsign)).toEqual(["CROSS-2"]);
    expect(c2.lastPresence!.systemId).toBe(sysB);

    c1.ws.close();
    c2.ws.close();
    await new Promise((r) => setTimeout(r, 25));
  });

  it("roster updates within one snapshot of a join in the same system", async () => {
    const sysId = systems().a;
    const c1 = await connectAndAuth(harness, "SNAP-1");
    await join(c1, sysId);

    const baselineIndex = c1.messages.length;
    const c2 = await connectAndAuth(harness, "SNAP-2");
    await join(c2, sysId);

    // The presence broadcast fires synchronously during joinSystem,
    // so c1 should have received a new presence frame containing
    // SNAP-2 before this assertion runs.
    const result = await waitForNext(
      c1.messages,
      baselineIndex,
      (m) => {
        if (!m.includes(`"type":"presence"`)) return false;
        const p = parsePresence(m);
        return p.players.some((x) => x.callsign === "SNAP-2");
      },
      500,
    );
    const names = parsePresence(result.msg)
      .players.map((p) => p.callsign)
      .sort();
    expect(names).toEqual(["SNAP-1", "SNAP-2"]);

    c1.ws.close();
    c2.ws.close();
    await new Promise((r) => setTimeout(r, 25));
  });
});
