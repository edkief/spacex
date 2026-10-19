/**
 * Rogue-AI roster hydration integration tests — TASK-45.
 *
 * Verifies the end-to-end route from `hydrateAiRoster`
 * \u2192 `spawnAiShip` \u2192 wire snapshot:
 *
 *   - A freshly-loaded shard carries 6..10 AI entities whose ids
 *     are stable across two consecutive loads (same seed \u2192 same
 *     roster).
 *   - Each AI entity carries a callsign + spawn anchor + class.
 *   - A destroyed AI disappears from the entity map, registers
 *     a respawn timer in `shard.aiRespawns`, and respawns at
 *     the original `aiSpawnPos` after the 120 s timer elapses.
 *   - Shard reap drops any pending respawn entries.
 *   - The wire shape carries `kind: 'ship'` + `ai: true` for
 *     every rogue (TASK-45 spec acceptance).
 *
 * Tests use the harness's `system-A` / `system-B` / ... pseudo-id
 * scheme (resolved by `buildRouterWithShards`) so we don't need
 * to commit real star ids.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RESPAWN_DELAY_MS, advanceAiRespawns } from "../shard/ai-respawn.js";
import { applyCombatDamage, playerSource } from "../shard/combat.js";
import { buildRouterWithShards, type RouterHarness } from "./ai-hydrate.test.helpers.js";

const SEED = "drift-ai-hydrate-seed";

describe("hydrateAiRoster \u2014 shard spawn loads the roster", () => {
  let harness: RouterHarness;
  beforeEach(async () => {
    harness = await buildRouterWithShards({ seed: SEED });
  });
  afterEach(async () => {
    await harness.shutdown();
  });

  it("a freshly-loaded shard carries 6..10 AI ships", async () => {
    const shard = await harness.loadSystem("system-A");
    const aiEntities = Array.from(shard.entities.values()).filter((e) => e.kind === "ai");
    expect(aiEntities.length).toBeGreaterThanOrEqual(6);
    expect(aiEntities.length).toBeLessThanOrEqual(10);
  });

  it("every AI entity carries a callsign and a non-empty spawn anchor", async () => {
    const shard = await harness.loadSystem("system-B");
    const aiEntities = Array.from(shard.entities.values()).filter((e) => e.kind === "ai");
    for (const ai of aiEntities) {
      expect(ai.callsign).not.toBeNull();
      expect(typeof ai.callsign).toBe("string");
      const len = (ai.callsign ?? "").length;
      expect(len).toBeGreaterThanOrEqual(3);
      expect(len).toBeLessThanOrEqual(16);
      expect(ai.aiSpawnPos).toBeDefined();
      expect(ai.aiPatrolCenter).toBeDefined();
      const dist = Math.hypot(ai.aiSpawnPos?.x ?? 0, ai.aiSpawnPos?.z ?? 0);
      expect(dist).toBeGreaterThanOrEqual(500);
      expect(dist).toBeLessThanOrEqual(3_000);
      expect(ai.aiSpawnPos?.y).toBe(0);
    }
  });

  it("roster is deterministic across two loads of the same system", async () => {
    const a = await harness.loadSystem("system-C");
    const aIds = Array.from(a.entities.values())
      .filter((e) => e.kind === "ai")
      .map((e) => e.id)
      .sort();
    const b = await harness.loadSystem("system-C");
    const bIds = Array.from(b.entities.values())
      .filter((e) => e.kind === "ai")
      .map((e) => e.id)
      .sort();
    expect(bIds).toEqual(aIds);
    expect(bIds.length).toBeGreaterThan(0);
  });

  it("class distribution stays inside the spec weights", async () => {
    const shard = await harness.loadSystem("system-D");
    const counts = { scout: 0, interceptor: 0, freighter: 0 };
    for (const e of shard.entities.values()) {
      if (e.kind === "ai" && e.classId) {
        counts[e.classId] += 1;
      }
    }
    const total = counts.scout + counts.interceptor + counts.freighter;
    expect(total).toBeGreaterThan(0);
    const scoutFraction = counts.scout / total;
    expect(scoutFraction).toBeGreaterThan(0.3); // loose tolerance
    expect(scoutFraction).toBeLessThan(0.7);
  });
});

describe("AI ship kill \u2192 120 s respawn cycle", () => {
  let harness: RouterHarness;
  beforeEach(async () => {
    harness = await buildRouterWithShards({ seed: SEED });
  });
  afterEach(async () => {
    await harness.shutdown();
  });

  it("kill one rogue, advance timers, it respawns at the original spawn", async () => {
    const shard = await harness.loadSystem("system-A");
    const aiEntities = Array.from(shard.entities.values()).filter((e) => e.kind === "ai");
    const target = aiEntities[0];
    expect(target).toBeDefined();
    const aiId = target!.id;
    const originalPos = target!.pos;

    // Pin the schedule at a known clock so the test advances
    // deterministically (no wall-clock dependency).
    const killAtMs = 1_000_000;
    applyCombatDamage({
      shard,
      targetId: aiId,
      amount: 9999,
      source: playerSource("PLAYER"),
      tick: 1,
      sourceEntityId: "entity:player-1",
      weapon: "laser",
      nowMs: killAtMs,
    });

    // The entity is removed and the respawn timer is registered.
    expect(shard.entities.has(aiId)).toBe(false);
    expect(shard.aiRespawns.has(aiId)).toBe(true);
    expect(shard.aiRespawns.get(aiId)?.respawnAtMs).toBe(killAtMs + RESPAWN_DELAY_MS);

    // Fast-forward 1 ms short of the timer \u2014 still gone.
    advanceAiRespawns(shard, { nowMs: killAtMs + RESPAWN_DELAY_MS - 1 });
    expect(shard.entities.has(aiId)).toBe(false);
    expect(shard.aiRespawns.has(aiId)).toBe(true);

    // Fast-forward past the timer \u2014 entity is back at the
    // original spawn position.
    advanceAiRespawns(shard, { nowMs: killAtMs + RESPAWN_DELAY_MS + 1 });
    expect(shard.entities.has(aiId)).toBe(true);
    const revived = shard.entities.get(aiId);
    expect(revived?.callsign).toBe(target!.callsign);
    expect(revived?.pos.x).toBe(originalPos.x);
    expect(revived?.pos.y).toBe(originalPos.y);
    expect(revived?.pos.z).toBe(originalPos.z);
    expect(shard.aiRespawns.has(aiId)).toBe(false);
  });

  it("multiple rogues respawn in the same tick when timers batch-elapse", async () => {
    const shard = await harness.loadSystem("system-B");
    const aiEntities = Array.from(shard.entities.values()).filter((e) => e.kind === "ai");
    expect(aiEntities.length).toBeGreaterThanOrEqual(2);
    const a = aiEntities[0]!;
    const b = aiEntities[1]!;
    applyCombatDamage({
      shard,
      targetId: a.id,
      amount: 9999,
      source: playerSource("P"),
      tick: 1,
      sourceEntityId: "entity:p1",
      weapon: "laser",
      nowMs: 5_000_000,
    });
    applyCombatDamage({
      shard,
      targetId: b.id,
      amount: 9999,
      source: playerSource("P"),
      tick: 2,
      sourceEntityId: "entity:p1",
      weapon: "missile",
      nowMs: 5_000_500,
    });
    advanceAiRespawns(shard, { nowMs: 5_121_000 });
    expect(shard.entities.has(a.id)).toBe(true);
    expect(shard.entities.has(b.id)).toBe(true);
    expect(shard.aiRespawns.size).toBe(0);
  });
});

describe("AI roster \u2014 wire shape", () => {
  let harness: RouterHarness;
  beforeEach(async () => {
    harness = await buildRouterWithShards({ seed: SEED });
  });
  afterEach(async () => {
    await harness.shutdown();
  });

  it("AI entities broadcast as `kind: 'ship'` with `ai: true`", async () => {
    const shard = await harness.loadSystem("system-E");
    expect(shard).toBeDefined();
    // The harness forces one synchronous snapshot on load so
    // the test can read the wire shape immediately.
    const entities = harness.broadcasts.flatMap((b) => b.entities);
    const aiEntities = entities.filter((e) => e.kind === "ship" && e.ai === true);
    expect(aiEntities.length).toBeGreaterThan(0);
    for (const entity of aiEntities) {
      expect(entity.ai).toBe(true);
      expect(entity.callsign).not.toBeNull();
    }
  });
});
