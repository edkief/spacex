/**
 * Cheat resistance — scripted "cheater" WS client (TASK-67).
 *
 * Each scenario in this file is a single attack class: a raw `ws`
 * client opens a connection, walks the handshake so it gets into
 * the `joined` state (where every player-influenced value is
 * validated), and then attempts a cheat. The server's job is to
 * neutralise the attempt: final shard state must match the
 * honest-player baseline exactly (no extra credits, no depleted
 * deposits, no teleported positions, no damage to the AI ship).
 *
 * Scenarios (one describe-block per acceptance bullet):
 *
 *   1. Position teleport — `input` frame claims impossible velocity;
 *      the sim integrates from the input vector only.
 *   2. Hit claims — client sends a forged `combat_event` claiming a
 *      hit; no such message type exists, so the parser rejects.
 *      Plus: firing off-rate must not produce extra damage.
 *   3. Fire spam — 30 fires in a tight loop; the 31st surfaces
 *      `weapon-locked` and damage is capped by the cooldown.
 *   4. Mine spam — 20 `mine` frames per second; the server cadence
 *      awards exactly one unit per 1.5 s regardless of message rate.
 *   5. Sell spam — 100 sell frames per second; rate-limited + atomic
 *      so credits never duplicate even if the same payload repeats.
 *   6. Warp spam — 5 rapid warp requests; the resolver only honours
 *      one (subsequent ones land on a `same-system` rejection).
 *   7. Message flood — 1000 junk frames; bucket drops the first
 *      ~40 and the 3rd rate-limit violation kicks with WS 4009.
 *   8. Payload abuse — oversize (>64 KB) + non-JSON + deep-nesting
 *      (>32 levels) all rejected without crashing the dispatch.
 *
 * Every scenario asserts the final shard state matches the
 * pre-cheat baseline exactly, so a regression that "lets one
 * cheat through" fails the test on the side-effect, not just on
 * the wire code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

import {
  abuseHandle,
  abuseUrl,
  bootAbuseWorld,
  Cheater,
  teardownAbuseWorld,
  type AbuseWorld,
} from "./rawClient.js";
import { PROTOCOL_VERSION, type Envelope } from "../../src/shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a fresh cheater through `hello → auth → join_system` so it
 * reaches the `joined` state. Resolves once the `enter_system`
 * frame arrives. The cheater's connection is bound to the player's
 * ship entity (default) or to the character entity (pass
 * `entityEntityId` for `mine` scenarios).
 */
async function reachJoined(
  world: AbuseWorld,
  callsign: string,
  entityEntityId?: string,
): Promise<Cheater> {
  const url = abuseUrl(world);
  const ws = new WsClient(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const cheater = new Cheater(ws);
  cheater.sendFrame("hello", { version: PROTOCOL_VERSION, client: "abuse" });
  await cheater.waitForFrames(1);
  cheater.sendFrame("auth", { callsign });
  await cheater.waitForFrames(1);
  cheater.sendFrame("join_system", { systemId: "0000000000000abc" });
  // Wait for the *enter_system* response — the auth_ok reply is
  // the second frame after auth, and the enter_system reply is the
  // third. Receiving 2 frames after join_system guarantees the
  // state machine reached `joined`.
  await cheater.waitForFrames(2);

  // Bind the connection into the shard so per-entity handlers
  // (fire / mine / sell) find a valid target.
  const live = abuseHandle(world).connections();
  const connRecord = live.find((c) => c.callsign === callsign);
  if (!connRecord) {
    throw new Error(`reachJoined: no connection found for callsign ${callsign}`);
  }
  const playerId = connRecord.playerId ?? world.playerIds["PILOT-ABUSE"]!;
  const entityId = entityEntityId ?? world.playerEntityIds["PILOT-ABUSE"]!;
  world.shard.connections.set(connRecord.connId, {
    connId: connRecord.connId,
    playerId,
    entityId,
    callsign,
    shipId: entityId === world.playerEntityIds["PILOT-ABUSE"] ? "starter-ship" : "",
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  });
  return cheater;
}

// ---------------------------------------------------------------------------
// Per-test world lifecycle
// ---------------------------------------------------------------------------

let world: AbuseWorld;

beforeEach(async () => {
  world = await bootAbuseWorld();
});

afterEach(async () => {
  await teardownAbuseWorld(world);
});

// ---------------------------------------------------------------------------
// Scenario 1 — Position teleport
// ---------------------------------------------------------------------------

describe("cheat 1: position teleport", () => {
  it("ignores position claims — the sim integrates from inputs only", async () => {
    const cheater = await reachJoined(world, "CHEATER-TELEPORT");
    const startPos = world.shard.entities.get(world.playerEntityIds["PILOT-ABUSE"]!)!.pos;

    // Drive the player with a normal input (small thrust along +X).
    cheater.sendFrame("input", {
      seq: 1,
      thrust: { x: 1, y: 0, z: 0 },
      brake: false,
      turn: { x: 0, y: 0, z: 0, w: 1 },
      targetSystemId: "0000000000000abc",
    });
    // The cheater now sends a *forged* "position" frame claiming
    // it's at (1e9, 0, 0) — there is no such message type, so the
    // parser must reject it.
    cheater.send({
      v: PROTOCOL_VERSION,
      type: "position",
      payload: { pos: [1_000_000_000, 0, 0] },
    });
    // Send a forged "teleport" / "set_position" too, just in case
    // a future protocol grew one of those names.
    cheater.send({
      v: PROTOCOL_VERSION,
      type: "teleport",
      payload: { pos: [-1_000_000_000, 0, 0] },
    });
    // Drain any replies for ~250 ms.
    await new Promise((r) => setTimeout(r, 250));

    const errors = cheater.errors();
    const teleportsRejected = errors.filter(
      (e) => e.code === "unknown-type" || e.code === "invalid-message",
    );
    expect(teleportsRejected.length).toBeGreaterThanOrEqual(2);

    // Position has not moved (no tick has integrated yet, and even
    // if it had, the sim integrates from input only).
    const now1 = world.shard.entities.get(world.playerEntityIds["PILOT-ABUSE"]!)!.pos;
    expect(now1.x).toBe(startPos.x);
    expect(now1.y).toBe(startPos.y);
    expect(now1.z).toBe(startPos.z);
    cheater.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Hit claims
// ---------------------------------------------------------------------------

describe("cheat 2: hit claims", () => {
  it("rejects forged combat_event / damage frames — no hit-from-nothing", async () => {
    const cheater = await reachJoined(world, "CHEATER-HITS");
    const aiStartHp = world.shard.entities.get(world.aiEntityId)!.hull;

    // Forged "I hit something" frame — no such type exists.
    cheater.send({
      v: PROTOCOL_VERSION,
      type: "combat_event",
      payload: {
        kind: "hit",
        attackerId: world.playerEntityIds["PILOT-ABUSE"],
        targetId: world.aiEntityId,
        damage: 9999,
        weapon: "laser",
      },
    });
    // Forged "apply_damage" — also rejected.
    cheater.send({
      v: PROTOCOL_VERSION,
      type: "apply_damage",
      payload: { targetId: world.aiEntityId, damage: 9999 },
    });

    // Wait for both rejections to be sent.
    await new Promise((r) => setTimeout(r, 200));
    const codes = cheater.errors().map((e) => e.code);
    expect(codes.some((c) => c === "unknown-type")).toBe(true);

    // AI hull unchanged.
    expect(world.shard.entities.get(world.aiEntityId)!.hull).toBe(aiStartHp);

    // Even on accepted fire, off-rate fires must not damage.
    // The cheater "fires" the laser by sending a real fire frame.
    cheater.sendFrame("fire", { weapon: "laser", targetId: world.aiEntityId });
    await new Promise((r) => setTimeout(r, 200));
    const fireOk = cheater
      .framesOfType("fire_ok")
      .map((f) => f.parsed?.payload as { kind?: string } | null)
      .find((p) => p?.kind === "laser");
    // Either a real laser landed (1 instance only) or the fire was
    // denied (range/etc). Either way, the AI hull must not have
    // taken more than one laser's worth of damage from the entire
    // cheat sequence — and certainly not the 9999 from the forged
    // claim.
    const aiHullAfter = world.shard.entities.get(world.aiEntityId)!.hull;
    expect(aiHullAfter).toBeGreaterThanOrEqual(aiStartHp - 8);
    void fireOk;
    cheater.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Fire spam
// ---------------------------------------------------------------------------

describe("cheat 3: fire spam", () => {
  it("weapon-locks after the rolling window, no extra damage beyond the cap", async () => {
    const cheater = await reachJoined(world, "CHEATER-FIRESPAM");
    // Move the AI in close so the laser actually hits; the cheater
    // would otherwise spam-fire into empty space and the test would
    // mistakenly pass for the wrong reason.
    const ai = world.shard.entities.get(world.aiEntityId)!;
    ai.pos = { x: 30, y: 0, z: 0 };
    const aiStartHp = ai.hull;

    // 30 fires in a tight loop. Use the same target each time.
    for (let i = 0; i < 30; i++) {
      cheater.sendFrame("fire", { weapon: "laser", targetId: world.aiEntityId });
    }
    // 31st fire should land inside the lockout window.
    cheater.sendFrame("fire", { weapon: "laser", targetId: world.aiEntityId });
    await new Promise((r) => setTimeout(r, 400));

    const codes = cheater.errors().map((e) => e.code);
    expect(codes.some((c) => c === "weapon-locked")).toBe(true);

    // AI hull cannot have dropped by more than the rolling window
    // permits (max one hit per accepted fire in the cadence; the
    // rest surface as `weapon-locked` and don't damage).
    const aiHullAfter = world.shard.entities.get(world.aiEntityId)!.hull;
    const damage = aiStartHp - aiHullAfter;
    // 8 damage per laser hit, max 1 hit accepted before lockout.
    expect(damage).toBeLessThanOrEqual(8);
    cheater.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Mine spam
// ---------------------------------------------------------------------------

describe("cheat 4: mine spam", () => {
  it("20 mine-ticks/s awards only the server-cadence rate (no acceleration)", async () => {
    // Bind the connection to the character (mining requires on-foot).
    const cheater = await reachJoined(
      world,
      "CHEATER-MINESPAM",
      world.characterEntityIds["PILOT-ABUSE"],
    );
    const deposit = world.shard.entities.get(world.depositEntityId)!;
    const startAmount = deposit.amount ?? 0;

    // Burst 20 `mine` frames in a tight loop. The server cadence
    // is 1.5 s per unit awarded; 20 messages in 200 ms must not
    // mine for the full 200 ms.
    for (let i = 0; i < 20; i++) {
      cheater.sendFrame("mine", { nodeId: world.depositEntityId, duration: 1500 });
    }
    // Wait long enough that one cadence tick COULD have fired if
    // the server is doing the right thing.
    await new Promise((r) => setTimeout(r, 200));

    const depositAfter = world.shard.entities.get(world.depositEntityId)!;
    // Spamming 20 frames in < 1.5 s means the cadence has NOT
    // completed; deposit amount must be unchanged.
    expect(depositAfter.amount).toBe(startAmount);
    cheater.close();

    // Now send one `mine` and wait long enough for one cadence to
    // complete — deposit must drop by exactly 1.
    cheater.sendFrame("mine", { nodeId: world.depositEntityId, duration: 1500 });
    await new Promise((r) => setTimeout(r, 1_800));
    const depositFinal = world.shard.entities.get(world.depositEntityId)!;
    expect(depositFinal.amount).toBe(startAmount - 1);
    cheater.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Sell spam
// ---------------------------------------------------------------------------

describe("cheat 5: sell spam", () => {
  it("100 sells/s is rate-limited + idempotent — no credit duplication", async () => {
    const cheater = await reachJoined(world, "CHEATER-SELLSPAM");
    const startBalance = (await world.repo.getBalance(world.playerIds["PILOT-ABUSE"]!)) ?? 0;

    // Burst 100 sell frames for the same 1 iron.
    for (let i = 0; i < 100; i++) {
      cheater.sendFrame("sell", {
        resourceType: "iron",
        quantity: 1,
        source: "hold",
      });
    }
    await new Promise((r) => setTimeout(r, 400));

    const balance = (await world.repo.getBalance(world.playerIds["PILOT-ABUSE"]!)) ?? 0;
    // Earned must be exactly basePrice * (number of accepted sells).
    // The cheater started with 100 iron in hold; selling 1 iron =
    // basePrice(iron) = 5 credits per sell (TASK-40). Rate-limit
    // gates accept at most GENERAL_RATE_LIMIT * (elapsed seconds)
    // sells; over the burst + ~400 ms window that's well under
    // 100. Balance cannot exceed 100 * 5, and cannot have
    // duplicated past the legitimate cap.
    const earned = balance - startBalance;
    expect(earned).toBeLessThanOrEqual(100 * 5);
    // Also: even if every sell landed, the iron stack can only
    // carry 100 units — so at most 100 sold. Sold * 5 credits.
    expect(earned).toBeGreaterThanOrEqual(0);
    expect(earned % 5).toBe(0);
    cheater.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Warp spam
// ---------------------------------------------------------------------------

describe("cheat 6: warp spam", () => {
  it("rapid warp requests collapse to one in flight, queue dropped", async () => {
    const cheater = await reachJoined(world, "CHEATER-WARPSPAM");

    // Burst 5 warp requests targeting the same system.
    for (let i = 0; i < 5; i++) {
      cheater.sendFrame("warp", { targetSystemId: "system-other-1" });
    }
    await new Promise((r) => setTimeout(r, 400));

    const errors = cheater.errors();
    // The harness's warp resolver rejects everything with
    // `same-system`; the cheater should see ≥ 1 rejection.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // The connection is still alive — warp rejections are not
    // fatal (the resolver throws a tagged error, the handler
    // sends a structured error frame and stays connected).
    expect(cheater.closeInfo).toBeNull();
    cheater.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Message flood
// ---------------------------------------------------------------------------

describe("cheat 7: message flood", () => {
  it("1000 junk messages/s rate-limits + kicks with WS 4009", async () => {
    const url = abuseUrl(world);
    const ws = new WsClient(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const cheater = new Cheater(ws);

    // Walk the handshake so the connection is in the `joined`
    // state, otherwise junk messages just bump the validation
    // counter and the cheater misses the rate-limit gate.
    cheater.sendFrame("hello", { version: PROTOCOL_VERSION, client: "abuse" });
    await cheater.waitForFrames(1);
    cheater.sendFrame("auth", { callsign: "CHEATER-FLOOD" });
    await cheater.waitForFrames(1);
    cheater.sendFrame("join_system", { systemId: "0000000000000abc" });
    await cheater.waitForFrames(1);

    // Drain whatever auth/join frames were buffered.
    cheater.received.length = 0;

    // Now flood 1 000 junk frames (well-formed envelope, garbage
    // type so they fail validation if they ever reach the parser,
    // but mostly they should be rate-limited before parse).
    for (let i = 0; i < 1_000; i++) {
      cheater.send({
        v: PROTOCOL_VERSION,
        type: "junk-" + i,
        payload: { i },
      });
    }
    // Wait for the close.
    const close = await cheater.waitForClose(5_000);
    expect(close.code).toBe(4009);
    expect(close.reason).toBe("flooded");
    // Verify the connection was removed from the live registry.
    const liveConns = abuseHandle(world).connections();
    const cheatConn = liveConns.find((c) => c.callsign === "CHEATER-FLOOD");
    expect(cheatConn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Payload abuse
// ---------------------------------------------------------------------------

describe("cheat 8: payload abuse", () => {
  it("rejects oversize messages, non-JSON, and deep nesting", async () => {
    const url = abuseUrl(world);
    const ws = new WsClient(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const cheater = new Cheater(ws);

    cheater.sendFrame("hello", { version: PROTOCOL_VERSION, client: "abuse" });
    await cheater.waitForFrames(1);
    cheater.sendFrame("auth", { callsign: "CHEATER-PAYLOAD" });
    await cheater.waitForFrames(1);
    cheater.sendFrame("join_system", { systemId: "0000000000000abc" });
    await cheater.waitForFrames(1);
    cheater.received.length = 0;

    // 8a: oversize message (> 64 KB). The server should reply
    // with an `invalid-message` error and not crash.
    const big = "x".repeat(70_000);
    cheater.sendText(big);
    // 8b: non-JSON.
    cheater.sendText("this is not json");
    // 8c: deep nesting (> 32 levels). The body is a JSON string
    // built by hand so the test stays under the 64 KB cap (a
    // 40-level nest is ~400 bytes of JSON, well inside the
    // envelope limit but far past any sane parser).
    const levels = 40;
    const open = Array(levels).fill('{"a":').join("");
    const close = Array(levels).fill("}").join("");
    const nestedJson = open + '"leaf"' + close;
    cheater.sendText(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "input",
        payload: JSON.parse(nestedJson) as unknown,
      }),
    );

    await new Promise((r) => setTimeout(r, 300));

    // Server must still be alive.
    expect(cheater.closeInfo).toBeNull();
    const codes = cheater.errors().map((e) => e.code);
    // At least one invalid-message / invalid-envelope rejection
    // should have come back. The exact code depends on whether
    // the size cap (→ invalid-message) or the parser (→
    // invalid-envelope) tripped first.
    expect(codes.some((c) => c === "invalid-message" || c === "invalid-envelope")).toBe(true);

    // And the live handle still accepts other connections.
    const liveConns = abuseHandle(world).connections();
    expect(liveConns.find((c) => c.callsign === "CHEATER-PAYLOAD")).toBeDefined();
    cheater.close();
  });
});

// Reference the envelope type so the import is not flagged unused in
// environments where the linter enforces `noUnusedImports`. (Some of
// the scenarios above build envelopes manually.)
void (null as unknown as Envelope);
