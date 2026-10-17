/**
 * Player-domain tests for the SQLite repository (TASK-62 AC5).
 *
 * Exercises `createPlayer`, `findPlayerByCallsign`, and `findPlayerById`
 * against a fresh in-memory database each test. Call-sign uniqueness is
 * exercised here because it lives in the same UNIQUE index.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";
import { CallsignTakenError } from "./errors.js";

installRepoHooks();

describe("players", () => {
  it("createPlayer stores a row with default credit balance and finds it by callsign", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "TEST-ALPHA",
      homeSystemId: "system-001",
    });
    expect(player.callsign).toBe("TEST-ALPHA");
    expect(player.credits).toBe(500);
    expect(player.homeSystemId).toBe("system-001");
    expect(player.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(player.createdAt).toBeInstanceOf(Date);
    expect(Number.isFinite(player.createdAt.getTime())).toBe(true);

    const found = await repo.findPlayerByCallsign("TEST-ALPHA");
    expect(found?.id).toBe(player.id);

    const byId = await repo.findPlayerById(player.id);
    expect(byId?.callsign).toBe("TEST-ALPHA");

    const missing = await repo.findPlayerByCallsign("TEST-NOT-THERE");
    expect(missing).toBeNull();
  });

  it("createPlayer raises CallsignTakenError on a duplicate callsign", async () => {
    const { repo } = active();
    await repo.createPlayer({
      callsign: "TEST-DUP",
      homeSystemId: "system-001",
    });
    await expect(
      repo.createPlayer({
        callsign: "TEST-DUP",
        homeSystemId: "system-002",
      }),
    ).rejects.toBeInstanceOf(CallsignTakenError);
  });
});
