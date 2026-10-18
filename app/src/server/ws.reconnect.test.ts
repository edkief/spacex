/**
 * Reconnect + resync integration tests for TASK-17.
 *
 * Boots a real Fastify + WebSocket server in-process, wires the
 * galaxy router + DB-backed repo, and exercises:
 *
 *   - **Input dispatch.** A validated `input` frame from a
 *     `joined`-state connection is routed into the shard's
 *     seq-protected slot and integrated on the next tick.
 *   - **Position continuity after mid-flight drop.** Inputs
 *     advance the entity; closing the socket stops the
 *     integration; a fresh reconnect rebinds the entity and
 *     its last-known position is preserved.
 *   - **Entity-count invariant.** Reconnecting never spawns a
 *     second entity for the same player — the ship is keyed by
 *     shipId, not connection id.
 *   - **Idle continuation.** Inputs from a removed
 *     (closed/dropped) connection are silently dropped with a
 *     debug log; the entity stays simulated (idle).
 *   - **Reap + rejoin.** When the shard reaps while the player
 *     is away, the reconnect loads the ship from the DB and
 *     finds it at its last-flush position.
 *
 * The harness mirrors `router.ws-bridge.test.ts` so the tests
 * run against the real server code path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import { attachWs, type WsHandle } from "./ws.js";
import { buildAuthResolver, buildLogoutResolver } from "./auth/resolver.js";
import { buildRouterJoinResolver } from "./galaxy/join-resolver.js";
import { GalaxyRouter } from "./galaxy/router.js";
import {
  buildConnSender,
  buildPresenceBroadcaster,
  createConnectionCloseHook,
} from "./galaxy/ws-router-bridge.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import { generateStars } from "@shared/galaxy/stars.js";

import { installRepoHooks, active } from "./db/repo.test.shared.js";
import { assertValidSecret } from "./auth/token.js";
import { simulateNTicks as _unused } from "./shard/index.js";
void _unused;

installRepoHooks();

const SESSION_SECRET = "RECONNECT-TEST-SECRET-DO-NOT-USE-IN-PRODUCTION-1234567890";
const SEED = "RECONNECT-TEST-SEED";
const STAR_COUNT = 8;

interface ReconnectHarness {
  app: FastifyInstance;
  handle: WsHandle;
  router: GalaxyRouter;
  port: number;
  url: string;
}

async function bootReconnectHarness(
  args: {
    reapGraceMs?: number;
    reapIntervalMs?: number;
  } = {},
): Promise<ReconnectHarness> {
  const { repo } = active();
  assertValidSecret(SESSION_SECRET);

  const app = Fastify({ logger: false });
  const { registerCallsignRoutes } = await import("./routes/callsigns.js");
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
    debugLogger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const router = new GalaxyRouter({
    repo,
    galaxySeed: SEED,
    galaxyStarCount: STAR_COUNT,
    reapGraceMs: args.reapGraceMs ?? 60_000,
    reapIntervalMs: args.reapIntervalMs ?? 60_000,
    presenceBroadcaster: buildPresenceBroadcaster({ registry: handle.registry }),
    connSender: buildConnSender({ registry: handle.registry }),
  });
  handle.setOnConnectionClose(createConnectionCloseHook({ router }));
  handle.setJoinResolver(buildRouterJoinResolver({ repo, router }));
  // TASK-17: the `input` dispatch handler uses `options.shardFor`
  // to find the player's current shard; the default is a no-op.
  handle.setShardFor((conn) => {
    if (conn.systemId === null) return undefined;
    return router.get(conn.systemId);
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);

  return {
    app,
    handle,
    router,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
  };
}

async function closeReconnectHarness(h: ReconnectHarness): Promise<void> {
  await h.handle.close();
  await h.app.close();
  await h.router.shutdown();
}

async function claimCallsign(h: ReconnectHarness, callsign: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/callsigns",
    payload: { callsign },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string };
  return body.token;
}

interface ConnectedClient {
  ws: WsClient;
  messages: string[];
  playerId: string;
  callsign: string;
  systemId: string | null;
}

async function openAndAuth(
  h: ReconnectHarness,
  callsign: string,
  tokenOverride?: string,
): Promise<ConnectedClient> {
  // Reconnects reuse the token from the original claim rather than
  // re-claiming the callsign (TASK-17 acceptance: "same token").
  const token = tokenOverride ?? (await claimCallsign(h, callsign));
  const ws = new WsClient(h.url);
  const messages: string[] = [];
  ws.on("message", (data) => {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    messages.push(buf.toString("utf8"));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  ws.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await waitForMessage(messages, (m) => m.includes(`"type":"hello"`));
  ws.send(encodeEnvelope("auth", { token }));
  const authOk = await waitForMessage(messages, (m) => m.includes(`"type":"auth_ok"`));
  const authPayload = JSON.parse(authOk) as {
    payload: { playerId: string; callsign: string };
  };

  return {
    ws,
    messages,
    playerId: authPayload.payload.playerId,
    callsign: authPayload.payload.callsign,
    systemId: null,
  };
}

async function joinSystem(c: ConnectedClient, systemId: string): Promise<void> {
  c.ws.send(encodeEnvelope("join_system", { systemId }));
  await waitForMessage(c.messages, (m) => m.includes(`"type":"enter_system"`));
  c.systemId = systemId;
}

async function waitForMessage(
  messages: string[],
  predicate: (msg: string) => boolean,
  timeoutMs = 1500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < messages.length; i++) {
      if (predicate(messages[i]!)) {
        return messages[i]!;
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for matching message. Got: ${JSON.stringify(messages)}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

/**
 * Drive the shard's sim with a controlled clock for `ticks` logical
 * ticks. The shard's auto-chained timer keeps running on real time,
 * but we ALSO advance the fake clock on each call so the per-tick
 * accumulator picks up the right elapsed time. We restore the
 * original clock when done.
 *
 * `shard` is the per-system shard; we read its `sim.hooks.clock`
 * (the same seam `sim.test.ts` uses) and patch it for the duration
 * of the call.
 */
function driveSimTicks(shard: ReturnType<GalaxyRouter["get"]>, ticks: number): void {
  const hooks = (shard!.sim as unknown as { hooks: { clock: () => number } }).hooks;
  const originalClock = hooks.clock;
  const lastTickReal = (shard!.sim as unknown as { lastTickReal: number }).lastTickReal;
  // Start the fake clock at the shard's existing `lastTickReal` so
  // a manual `tick()` after the override sees a non-negative
  // elapsed and steps immediately.
  let now = lastTickReal >= 0 ? lastTickReal : Date.now();
  hooks.clock = () => now;
  try {
    // Prime the loop so the first manual `tick()` doesn't try to
    // step with zero elapsed.
    shard!.sim.tick();
    for (let i = 0; i < ticks; i++) {
      now += 50;
      shard!.sim.tick();
    }
  } finally {
    hooks.clock = originalClock;
  }
}

function firstSystemId(): string {
  return generateStars(SEED, STAR_COUNT)[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server/ws reconnect + resync (TASK-17)", () => {
  let harness: ReconnectHarness;

  beforeEach(async () => {
    harness = await bootReconnectHarness();
  });
  afterEach(async () => {
    await closeReconnectHarness(harness);
  });

  it("routes a validated input frame into the shard's seq-protected slot", async () => {
    const sysId = firstSystemId();
    const c = await openAndAuth(harness, "INPUT-1");
    await joinSystem(c, sysId);

    // Snapshot the ship position, send 10 inputs with constant 0.4
    // thrust, drive the sim, then read back the entity position.
    const shard = harness.router.get(sysId)!;
    // The shard's sim is auto-started on a real timer; we drive it
    // manually with a controlled clock so the test doesn't depend
    // on wall-clock sleeping. The auto-loop may have advanced
    // `lastTickReal` via `performance.now()` already, so we read
    // its current value and start our fake clock from there so the
    // first manual `tick()` sees a non-negative elapsed.
    const fakeHooks = (
      shard.sim as unknown as {
        hooks: { clock: () => number };
      }
    ).hooks;
    const originalClock = fakeHooks.clock;
    const lastTickReal = (shard.sim as unknown as { lastTickReal: number }).lastTickReal;
    let now = lastTickReal >= 0 ? lastTickReal : 1_000_000;
    fakeHooks.clock = () => now;

    const shipEntity = Array.from(shard.entities.values()).find((e) => e.playerId === c.playerId);
    expect(shipEntity).toBeDefined();
    const startPos = { ...shipEntity!.pos };
    const startTick = shard.sim.currentTick;

    for (let i = 0; i < 10; i++) {
      c.ws.send(
        encodeEnvelope("input", {
          seq: i + 1,
          thrust: 0.4,
          turn: 0,
          pitch: 0,
          yaw: 0,
          fire: false,
          lock: false,
          action: null,
        }),
      );
    }
    // Yield once so the server processes the queued WS frames
    // before we drive the sim.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));
    // Confirm the connection is bound to the entity and accepted
    // all 10 inputs (lastSeq advanced past 1..10).
    const conn = Array.from(shard.connections.values()).find((c2) => c2.callsign === "INPUT-1")!;
    expect(conn.entityId).toBe(shipEntity!.id);
    expect(conn.lastSeq).toBe(10);
    expect(conn.pendingInput).not.toBeNull();

    // Drive 4 logical ticks (0.2 s of sim time) so the latest
    // queued input is integrated.
    for (let i = 0; i < 4; i++) {
      now += 50;
      shard.sim.tick();
    }

    const afterEntity = Array.from(shard.entities.values()).find((e) => e.playerId === c.playerId)!;
    const dx = afterEntity.pos.x - startPos.x;
    const dy = afterEntity.pos.y - startPos.y;
    const dz = afterEntity.pos.z - startPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // 0.4 thrust for ~4 ticks (0.2 s sim time) — non-trivial
    // displacement on the scout (small but unambiguous).
    expect(distance).toBeGreaterThan(0);
    // The sim advanced past the snapshot tick we started at.
    expect(shard.sim.currentTick).toBeGreaterThan(startTick);

    fakeHooks.clock = originalClock;
    c.ws.close();
  });

  it("discards inputs from a connection that was already removed from the shard", async () => {
    const sysId = firstSystemId();
    const c = await openAndAuth(harness, "STALE-1");
    await joinSystem(c, sysId);

    const shard = harness.router.get(sysId)!;
    const shipEntity = Array.from(shard.entities.values()).find((e) => e.playerId === c.playerId)!;
    const startPos = { ...shipEntity.pos };

    // Capture the connection's connId before the close handler
    // detaches it from the shard.
    const oldConnId = Array.from(shard.connections.values()).find(
      (conn) => conn.callsign === c.callsign,
    )!.connId;

    c.ws.close();
    await waitFor(() => shard.connections.size === 0, 500);

    // The connection is gone but the entity survives.
    expect(shard.entities.has(shipEntity.id)).toBe(true);

    // The integration queue is gone too — no inputs are applied.
    driveSimTicks(shard, 4);
    const afterEntity = shard.entities.get(shipEntity.id)!;
    expect(afterEntity.pos.x).toBeCloseTo(startPos.x, 6);
    expect(afterEntity.pos.y).toBeCloseTo(startPos.y, 6);
    expect(afterEntity.pos.z).toBeCloseTo(startPos.z, 6);

    // The OLD connId is no longer in `shard.connections` — any
    // future input arriving under that id would be silently
    // dropped by `pushPlayerInput` (the conn lookup misses).
    expect(shard.connections.has(oldConnId)).toBe(false);
  });

  it("rebind on reconnect: ship survives mid-flight drop and stays at last known position", async () => {
    const sysId = firstSystemId();
    const originalToken = await claimCallsign(harness, "REBIND-1");
    const c = await openAndAuth(harness, "REBIND-1", originalToken);
    await joinSystem(c, sysId);

    const shard = harness.router.get(sysId)!;
    const shipEntity = Array.from(shard.entities.values()).find((e) => e.playerId === c.playerId)!;
    const shipId = shipEntity.id;

    // Send 5 inputs to advance the ship, drive the sim, snapshot
    // the post-input position.
    for (let i = 0; i < 5; i++) {
      c.ws.send(
        encodeEnvelope("input", {
          seq: i + 1,
          thrust: 0.5,
          turn: 0,
          pitch: 0,
          yaw: 0,
          fire: false,
          lock: false,
          action: null,
        }),
      );
    }
    driveSimTicks(shard, 4);
    const midPos = { ...shard.entities.get(shipId)!.pos };

    // Close the socket mid-flight (no warp, no manual leave).
    c.ws.close();
    await waitFor(() => shard.connections.size === 0, 500);

    // Entity still exists — no world reset.
    expect(shard.entities.has(shipId)).toBe(true);

    // Reconnect with a fresh socket using the SAME token
    // (TASK-17 acceptance: "same token, join_system to the same
    // system").
    const c2 = await openAndAuth(harness, "REBIND-1", originalToken);
    await joinSystem(c2, sysId);

    // Same shard, same entity id — the entity is keyed by shipId
    // (not connId), so reconnecting never creates a duplicate.
    const shard2 = harness.router.get(sysId)!;
    expect(shard2).toBe(shard);
    expect(shard2.entities.has(shipId)).toBe(true);
    expect(shard2.entities.size).toBe(shard.entities.size);
    const reEntity = shard2.entities.get(shipId)!;
    // Position continuity: < 1 u from where the ship stopped.
    const dx = reEntity.pos.x - midPos.x;
    const dy = reEntity.pos.y - midPos.y;
    const dz = reEntity.pos.z - midPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(distance).toBeLessThan(1);

    c2.ws.close();
  });

  it("entity-count invariant: reconnection never creates a second ship for the same player", async () => {
    const sysId = firstSystemId();
    const originalToken = await claimCallsign(harness, "INVARIANT-1");
    const c = await openAndAuth(harness, "INVARIANT-1", originalToken);
    await joinSystem(c, sysId);

    const shard = harness.router.get(sysId)!;
    const playerEntities = (): number =>
      Array.from(shard.entities.values()).filter((e) => e.playerId === c.playerId).length;
    expect(playerEntities()).toBe(1);

    c.ws.close();
    await waitFor(() => shard.connections.size === 0, 500);
    expect(playerEntities()).toBe(1);

    const c2 = await openAndAuth(harness, "INVARIANT-1", originalToken);
    await joinSystem(c2, sysId);
    expect(playerEntities()).toBe(1);

    c2.ws.close();
    await waitFor(() => shard.connections.size === 0, 500);
    expect(playerEntities()).toBe(1);

    const c3 = await openAndAuth(harness, "INVARIANT-1", originalToken);
    await joinSystem(c3, sysId);
    expect(playerEntities()).toBe(1);

    c3.ws.close();
  });

  it("reap-and-rejoin: shard reaps while the player is away; reconnect hydrates from DB at last-flush position", async () => {
    // Short reap window so the test can drive a real reap sweep
    // without burning wall-clock minutes.
    await closeReconnectHarness(harness);
    harness = await bootReconnectHarness({
      reapGraceMs: 50,
      reapIntervalMs: 50,
    });
    const sysId = firstSystemId();
    const originalToken = await claimCallsign(harness, "REAP-1");
    const c = await openAndAuth(harness, "REAP-1", originalToken);
    await joinSystem(c, sysId);

    const shard = harness.router.get(sysId)!;
    const shipEntity = Array.from(shard.entities.values()).find((e) => e.playerId === c.playerId)!;
    const shipId = shipEntity.id;

    // Advance the ship a few ticks so the DB row diverges from
    // the origin. Each input has a fresh seq (1..5).
    for (let i = 0; i < 5; i++) {
      c.ws.send(
        encodeEnvelope("input", {
          seq: i + 1,
          thrust: 0.6,
          turn: 0,
          pitch: 0,
          yaw: 0,
          fire: false,
          lock: false,
          action: null,
        }),
      );
    }
    driveSimTicks(shard, 4);

    // Drop the player + drain the reap grace + force the sweep.
    c.ws.close();
    await waitFor(() => shard.connections.size === 0, 500);
    await harness.router.forceReap(sysId);
    expect(harness.router.has(sysId)).toBe(false);

    // The reconnect hits the empty router: the router must
    // reload from DB so the ship appears at its last-flush
    // position.
    const c2 = await openAndAuth(harness, "REAP-1", originalToken);
    await joinSystem(c2, sysId);

    const shard2 = harness.router.get(sysId)!;
    expect(shard2).toBeDefined();
    // A FRESH shard (generation bumped from 1 to 2 on the
    // respawn).
    expect(shard2.generation).toBe(2);
    const reloaded = shard2.entities.get(shipId);
    expect(reloaded).toBeDefined();
    // Position continuity from the live entity's last-known spot.
    const beforePos = shipEntity.pos;
    const afterPos = reloaded!.pos;
    const dx = afterPos.x - beforePos.x;
    const dy = afterPos.y - beforePos.y;
    const dz = afterPos.z - beforePos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(distance).toBeLessThan(1);

    c2.ws.close();
  });
});
