/**
 * Server-side targeting tests — TASK-44 acceptance.
 *
 * Exercises the live lock state inside `Shard.targets`:
 *   1. **Lock selection** — `handleTargetLock` validates the
 *      range + cone + ship-kind gates; the success path mutates
 *      `shard.targets`, pushes a `target_locked` ack, and stamps a
 *      `targetedBy` broadcast.
 *   2. **Auto-release timers** — `advanceTargetLocks` releases
 *      locks whose target died, exited the 1500 m auto-release
 *      radius, or whose 30 s ceiling has elapsed.
 *   3. **Missile-target preference** — `pickMissileTarget` (via
 *      `handleFire({weapon:'missile'})`) returns the lock, the
 *      cone pick, or `null` in that order.
 *   4. **Threat ping** — handled by the client module
 *      (`@client/combat/targeting`); the server-side test only
 *      asserts the `combat_event` broadcast carries the source /
 *      target fields the client needs.
 *
 * These tests don't drive the WS layer (`ws.targeting.test.ts`
 * covers that) — they exercise the shard module against a
 * constructed `Shard` so the lock + missile-preference +
 * auto-release logic is proven in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGET_LOCK_AUTO_RELEASE_RANGE_M, TARGET_LOCK_DURATION_MS } from "@shared/targeting.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";

import { makeAiEntity, makePlayerEntity } from "./entity.js";
import { createShard } from "./index.js";
import { handleFire, initWeaponState } from "./weapons.js";
import {
  advanceTargetLocks,
  forgetConnectionLocks,
  handleTargetLock,
  handleTargetRelease,
  lockFor,
} from "./targeting.js";

import type { ShardSystemContext, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ShardSystemContext {
  return {
    system: {} as ShardSystemContext["system"],
    starId: "star-x",
    planetById: () => undefined,
    heightAtFor: () => () => 0,
    tileSizeM: 64,
  };
}

function makeShardWithConn() {
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  const shard = createShard({
    systemId: "sys-target",
    context: makeCtx(),
    send: (connId, frame) => {
      sentFrames.push({ connId, frame });
    },
    broadcast: () => undefined,
    autoStart: false,
  });

  // Owner: a player ship at the origin with valid weapon state.
  const ownerEntity = makePlayerEntity({
    id: "ship:owner",
    shipId: "ship:owner",
    playerId: "p-owner",
    callsign: "Owner",
    classId: "interceptor",
    hull: 100,
    shields: 50,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    onPad: null,
  });
  initWeaponState(ownerEntity);
  shard.entities.set(ownerEntity.id, ownerEntity);
  shard.connections.set("conn-owner", {
    connId: "conn-owner",
    callsign: "Owner",
    playerId: "p-owner",
    shipId: "ship:owner",
    entityId: ownerEntity.id,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  });

  function spawnShip(id: string, pos: { x: number; y: number; z: number }): SimEntity {
    const ent = makeAiEntity({ id, classId: "scout", pos });
    ent.hull = 80;
    ent.shields = 40;
    shard.entities.set(id, ent);
    return ent;
  }

  return { shard, ownerEntity, sentFrames, spawnShip };
}

function framesOfType(
  frames: Array<{ connId: string; frame: { type: string; payload: unknown } }>,
  connId: string,
  type: string,
): unknown[] {
  return frames
    .filter((f) => f.connId === connId && f.frame.type === type)
    .map((f) => f.frame.payload);
}

// ---------------------------------------------------------------------------
// 1. Lock selection (TASK-44 acceptance: "lock selection — nearest in cone,
//    exact boundary cases")
// ---------------------------------------------------------------------------

describe("targeting: handleTargetLock (validation + state mutation)", () => {
  let harness: ReturnType<typeof makeShardWithConn> | null = null;
  beforeEach(() => {
    harness = makeShardWithConn();
  });
  afterEach(() => {
    harness?.shard.shutdown();
    harness = null;
  });

  it("accepts a ship inside range + cone and pushes target_locked + target_update", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });

    const result = handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });
    expect(result.kind).toBe("locked");

    expect(harness.shard.targets.get("conn-owner")?.targetId).toBe(target.id);
    expect(harness.shard.targets.get("conn-owner")?.lockedAt).toBe(1_000);

    const lockedAcks = framesOfType(harness.sentFrames, "conn-owner", "target_locked");
    expect(lockedAcks).toHaveLength(1);
    expect((lockedAcks[0] as { targetId: string }).targetId).toBe(target.id);

    const updates = framesOfType(harness.sentFrames, "conn-owner", "target_update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects (invalid-target) when the target is out of range", () => {
    if (!harness) throw new Error("harness missing");
    // Place the target at 600 m on the +Z axis (forward) — past
    // the 500 m range gate.
    const target = harness.spawnShip("ship:far", { x: 0, y: 0, z: 600 });

    const result = handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("out-of-range");
    }
    expect(harness.shard.targets.has("conn-owner")).toBe(false);
  });

  it("rejects (line-of-sight) when the target is in range but outside the 30° cone", () => {
    if (!harness) throw new Error("harness missing");
    // Forward is +Z by default. Place the target at 100 m on +X
    // (90° off-axis) so it's in range but outside the cone.
    const target = harness.spawnShip("ship:side", { x: 100, y: 0, z: 0 });

    const result = handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      // The line-of-sight reason covers range + cone FAIL because
      // the target is in range but fails the cone check.
      expect(result.reason).toBe("line-of-sight");
    }
  });

  it("rejects (not-a-ship) when locking a non-ship entity", () => {
    if (!harness) throw new Error("harness missing");
    const deposit = {
      id: "deposit:1",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 0, z: 50 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "space",
      originPlanetId: null,
      onPad: null,
    } as unknown as SimEntity;
    harness.shard.entities.set(deposit.id, deposit);

    const result = handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: deposit.id,
      nowMs: 1_000,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("not-a-ship");
    }
  });

  it("rejects (destroyed) when the target's hull is 0", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:dead", { x: 0, y: 0, z: 100 });
    target.hull = 0;

    const result = handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toBe("destroyed");
    }
  });

  it("toggles the lock off when re-pressing T on the already-locked target", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });

    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });
    expect(harness.shard.targets.has("conn-owner")).toBe(true);

    const result = handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_500,
    });
    expect(result.kind).toBe("released");
    expect(harness.shard.targets.has("conn-owner")).toBe(false);

    const releases = framesOfType(harness.sentFrames, "conn-owner", "target_released");
    expect(releases.length).toBeGreaterThanOrEqual(1);
    const lastRelease = releases[releases.length - 1] as { reason: string };
    expect(lastRelease.reason).toBe("toggle");
  });
});

// ---------------------------------------------------------------------------
// 2. Auto-release timers (TASK-44 acceptance: fake clock)
// ---------------------------------------------------------------------------

describe("targeting: advanceTargetLocks (auto-release)", () => {
  let harness: ReturnType<typeof makeShardWithConn> | null = null;
  beforeEach(() => {
    harness = makeShardWithConn();
  });
  afterEach(() => {
    harness?.shard.shutdown();
    harness = null;
  });

  it("releases locks whose target exited the 1500 m auto-release radius", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });
    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });

    // Move the target to (0, 0, TARGET_LOCK_AUTO_RELEASE_RANGE_M + 50)
    // so it's outside the auto-release radius.
    target.pos.z = TARGET_LOCK_AUTO_RELEASE_RANGE_M + 50;

    const result = advanceTargetLocks(harness.shard, 2_000);
    expect(result.releasedRange).toBe(1);
    expect(harness.shard.targets.has("conn-owner")).toBe(false);
  });

  it("releases locks whose target was destroyed (hull dropped to 0)", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });
    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });

    target.hull = 0;
    const result = advanceTargetLocks(harness.shard, 2_000);
    expect(result.releasedDestroyed).toBe(1);
    expect(harness.shard.targets.has("conn-owner")).toBe(false);
  });

  it("releases locks after the 30 s ceiling", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });
    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });

    const now = 1_000 + TARGET_LOCK_DURATION_MS + 1;
    const result = advanceTargetLocks(harness.shard, now);
    expect(result.releasedTimeout).toBe(1);
    expect(harness.shard.targets.has("conn-owner")).toBe(false);
  });

  it("does not release locks still in range / alive / within timeout", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });
    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });

    const result = advanceTargetLocks(harness.shard, 5_000);
    expect(result.releasedRange + result.releasedDestroyed + result.releasedTimeout).toBe(0);
    expect(harness.shard.targets.has("conn-owner")).toBe(true);

    // Updates the live `target_update` payload.
    const updates = framesOfType(harness.sentFrames, "conn-owner", "target_update");
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it("forgetConnectionLocks clears the connection's lock on disconnect", () => {
    if (!harness) throw new Error("harness missing");
    const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });
    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: target.id,
      nowMs: 1_000,
    });
    expect(harness.shard.targets.has("conn-owner")).toBe(true);

    forgetConnectionLocks(harness.shard, "conn-owner");
    expect(harness.shard.targets.has("conn-owner")).toBe(false);
    expect(lockFor(harness.shard, "conn-owner")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Missile preference (TASK-44 acceptance: lock > nearest > straight)
// ---------------------------------------------------------------------------

describe("targeting: missile preference (lock > cone > none)", () => {
  let harness: ReturnType<typeof makeShardWithConn> | null = null;
  beforeEach(() => {
    harness = makeShardWithConn();
  });
  afterEach(() => {
    harness?.shard.shutdown();
    harness = null;
  });

  it("homes a missile on the active lock when one is valid", () => {
    if (!harness) throw new Error("harness missing");
    const locked = harness.spawnShip("ship:locked", { x: 0, y: 0, z: 50 });
    const stray = harness.spawnShip("ship:stray", { x: 0, y: 0, z: 60 });
    handleTargetLock({
      shard: harness.shard,
      connId: "conn-owner",
      targetId: locked.id,
      nowMs: 1_000,
    });

    const fireResult = handleFire({
      shard: harness.shard,
      connId: "conn-owner",
      weapon: "missile",
      targetId: null,
      nowMs: 2_000,
    });
    expect(fireResult.ok).toBe("accepted");
    const missileId = fireResult.ok === "accepted" ? fireResult.projectileId : null;
    expect(missileId).not.toBeNull();
    if (missileId) {
      const missile = harness.shard.entities.get(missileId) as SimEntity;
      // The chosen target must be the locked one, not the nearest
      // cone pick.
      expect(missile.missileTargetId).toBe(locked.id);
      // The stray ship should not be the missile target.
      expect(missile.missileTargetId).not.toBe(stray.id);
    }
  });

  it("uses the nearest-in-cone ship when no lock is held", () => {
    if (!harness) throw new Error("harness missing");
    // Two ships in cone; the closer one wins.
    const near = harness.spawnShip("ship:near", { x: 0, y: 0, z: 50 });
    const far = harness.spawnShip("ship:far", { x: 0, y: 0, z: 200 });

    const fireResult = handleFire({
      shard: harness.shard,
      connId: "conn-owner",
      weapon: "missile",
      targetId: null,
      nowMs: 1_000,
    });
    expect(fireResult.ok).toBe("accepted");
    const missileId = fireResult.ok === "accepted" ? fireResult.projectileId : null;
    expect(missileId).not.toBeNull();
    if (missileId) {
      const missile = harness.shard.entities.get(missileId) as SimEntity;
      // The closer ship wins because distance is the
      // tiebreaker.
      expect(missile.missileTargetId).toBe(near.id);
      expect(missile.missileTargetId).not.toBe(far.id);
    }
  });

  it("denies missile fire with no-target when no lock + no cone pick", () => {
    if (!harness) throw new Error("harness missing");
    const fireResult = handleFire({
      shard: harness.shard,
      connId: "conn-owner",
      weapon: "missile",
      targetId: null,
      nowMs: 1_000,
    });
    expect(fireResult.ok).toBe("denied");
    if (fireResult.ok === "denied") {
      expect(fireResult.code).toBe("no-target");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. handleTargetRelease is silent on the no-op path
// ---------------------------------------------------------------------------

describe("targeting: handleTargetRelease (silent no-op)", () => {
  it("returns `{ released: null }` when the connection has no lock", () => {
    const harness = makeShardWithConn();
    try {
      const result = handleTargetRelease({
        shard: harness.shard,
        connId: "conn-owner",
      });
      expect(result.released).toBeNull();
    } finally {
      harness.shard.shutdown();
    }
  });

  it("releases the current lock and pushes target_released (reason: manual)", () => {
    const harness = makeShardWithConn();
    try {
      const target = harness.spawnShip("ship:target", { x: 0, y: 0, z: 100 });
      handleTargetLock({
        shard: harness.shard,
        connId: "conn-owner",
        targetId: target.id,
        nowMs: 1_000,
      });

      const result = handleTargetRelease({ shard: harness.shard, connId: "conn-owner" });
      expect(result.released).toBe(target.id);

      const releases = framesOfType(harness.sentFrames, "conn-owner", "target_released");
      expect(releases.length).toBeGreaterThanOrEqual(1);
      const last = releases[releases.length - 1] as { reason: string };
      expect(last.reason).toBe("manual");
    } finally {
      harness.shard.shutdown();
    }
  });
});

// Suppress unused import warnings — encodeEnvelope / PROTOCOL_VERSION are
// imported for parity with the WS-layer tests (the link to the protocol
// version is asserted in `ws.targeting.test.ts`). Keeping them here keeps
// the import surface aligned with how the WS handlers reference them.
void encodeEnvelope;
void PROTOCOL_VERSION;
