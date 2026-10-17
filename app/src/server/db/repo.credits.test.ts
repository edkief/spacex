/**
 * Credits-domain tests for the SQLite repository (TASK-62 AC5).
 *
 * Exercises `addCredits`, `withdrawCredits`, and `getCredits` against a
 * fresh in-memory database each test. Validates positive-amount
 * rejection and typed `InsufficientCreditsError` on overdraft attempts.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";
import { InsufficientCreditsError } from "./errors.js";

installRepoHooks();

describe("credits", () => {
  it("addCredits increments atomically and round-trips through getCredits", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-9",
      homeSystemId: "system-001",
    });
    expect(await repo.getCredits(player.id)).toBe(500);
    await repo.addCredits(player.id, 100);
    expect(await repo.getCredits(player.id)).toBe(600);
    await repo.addCredits(player.id, 50);
    expect(await repo.getCredits(player.id)).toBe(650);
  });

  it("withdrawCredits decrements and rejects overdrafts", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-10",
      homeSystemId: "system-001",
    });
    const updated = await repo.withdrawCredits(player.id, 200);
    expect(updated.credits).toBe(300);
    await expect(repo.withdrawCredits(player.id, 1000)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    // balance unchanged after rejection
    expect(await repo.getCredits(player.id)).toBe(300);
  });

  it("addCredits/withdrawCredits reject non-positive amounts", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-11",
      homeSystemId: "system-001",
    });
    await expect(repo.addCredits(player.id, 0)).rejects.toThrow();
    await expect(repo.addCredits(player.id, -5)).rejects.toThrow();
    await expect(repo.withdrawCredits(player.id, 0)).rejects.toThrow();
  });
});
