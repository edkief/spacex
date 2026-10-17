/**
 * Credits-domain tests for the SQLite repository (TASK-41).
 *
 * Exercises `addCredits`, `withdrawCredits`, and `getBalance` against
 * a fresh in-memory database each test. Covers:
 *   - starting balance (default 500 per spec)
 *   - add / withdraw happy path
 *   - atomic compare-and-swap on insufficient funds (zero floor)
 *   - non-positive amount rejection
 *   - 100 concurrent withdrawals against 500 → exactly 50 success,
 *     final balance 0 (TASK-41 AC #3)
 *   - transaction rollback when a callback throws mid-flight
 *     (TASK-41 AC #6 "transaction rollback on mid-failure")
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "./repo.test.shared.js";
import { InsufficientCreditsError } from "./errors.js";

installRepoHooks();

describe("credits — defaults", () => {
  it("starts a fresh player at exactly 500 credits", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-DEFAULT",
      homeSystemId: "system-001",
    });
    expect(player.credits).toBe(500);
    expect(await repo.getBalance(player.id)).toBe(500);
  });

  it("credits is persisted as a non-negative integer", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-PERSIST",
      homeSystemId: "system-001",
    });
    expect(Number.isInteger(player.credits)).toBe(true);
    expect(player.credits).toBeGreaterThanOrEqual(0);
    // Re-fetch through `findPlayerById` (a fresh row read) to confirm
    // the value survives a round trip.
    const refetched = await repo.findPlayerById(player.id);
    expect(refetched?.credits).toBe(500);
  });
});

describe("credits — add/withdraw", () => {
  it("addCredits increments atomically and round-trips through getBalance", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-9",
      homeSystemId: "system-001",
    });
    expect(await repo.getBalance(player.id)).toBe(500);
    await repo.addCredits(player.id, 100);
    expect(await repo.getBalance(player.id)).toBe(600);
    await repo.addCredits(player.id, 50);
    expect(await repo.getBalance(player.id)).toBe(650);
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
    expect(await repo.getBalance(player.id)).toBe(300);
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

  it("withdrawCredits clamps to the zero floor (no debt)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-FLOOR",
      homeSystemId: "system-001",
    });
    // Drain the whole balance in two withdrawals.
    await repo.withdrawCredits(player.id, 400);
    expect(await repo.getBalance(player.id)).toBe(100);
    // The next withdraw must throw and leave the balance untouched.
    await expect(repo.withdrawCredits(player.id, 200)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(await repo.getBalance(player.id)).toBe(100);
    // Emptying the balance is fine.
    await repo.withdrawCredits(player.id, 100);
    expect(await repo.getBalance(player.id)).toBe(0);
    // Overdrawing from zero must throw and keep the balance at 0.
    await expect(repo.withdrawCredits(player.id, 1)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(await repo.getBalance(player.id)).toBe(0);
  });
});

describe("credits — concurrency", () => {
  it("100 concurrent withdrawals of 10 against 500 → 50 success, balance 0", async () => {
    // TASK-41 AC #3: this is the load-bearing atomicity test. The
    // compare-and-swap SQL pattern (`credits = credits - ? WHERE
    // credits >= ?`) plus better-sqlite3's serialized writes means we
    // must observe exactly 50 successful rows and a final balance of
    // 0; not 490 (last-writer-wins), not a partial surplus.
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-RACE",
      homeSystemId: "system-001",
    });
    expect(await repo.getBalance(player.id)).toBe(500);

    // Fire 100 withdrawals as concurrently as JS will allow. Each
    // `Promise` resolves only after better-sqlite3 has serialised the
    // underlying UPDATE; awaiting all of them gives us a single
    // post-condition snapshot.
    const attempts = Array.from({ length: 100 }, () => repo.withdrawCredits(player.id, 10));
    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    expect(fulfilled.length).toBe(50);
    expect(rejected.length).toBe(50);
    // Every rejection should be InsufficientCreditsError — not a
    // generic crash from a torn UPDATE.
    for (const s of rejected) {
      if (s.status === "rejected") {
        expect(s.reason).toBeInstanceOf(InsufficientCreditsError);
      }
    }
    expect(await repo.getBalance(player.id)).toBe(0);
  });

  it("100 concurrent mixed add+withdraw operations preserve balance arithmetic", async () => {
    // Sanity check that interleaving adds and withdraws still respects
    // the SQL-level atomicity. Each `addCredits(50)` is matched by
    // exactly five `withdrawCredits(10)`; 50 of each totals to a
    // net +0 with no over/under-shoot.
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-MIX",
      homeSystemId: "system-001",
    });
    const start = await repo.getBalance(player.id);
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      ops.push(repo.addCredits(player.id, 50));
      ops.push(repo.withdrawCredits(player.id, 10));
      ops.push(repo.withdrawCredits(player.id, 10));
      ops.push(repo.withdrawCredits(player.id, 10));
      ops.push(repo.withdrawCredits(player.id, 10));
      ops.push(repo.withdrawCredits(player.id, 10));
    }
    const settled = await Promise.allSettled(ops);
    const failures = settled.filter((s) => s.status === "rejected");
    expect(failures.length).toBe(0);
    // +50 each iteration × 50 → +2500; -10×5 each iteration × 50 → -2500.
    expect(await repo.getBalance(player.id)).toBe(start);
  });
});

describe("credits — transactions", () => {
  it("runInTransaction commits when the callback resolves", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-TX",
      homeSystemId: "system-001",
    });
    // Cast to access the SQLite-specific `runInTransaction` helper.
    const sqliteRepo = repo as unknown as {
      runInTransaction: <T>(
        fn: (tx: {
          addCredits: (pid: string, amount: number) => { id: string; credits: number };
          withdrawCredits: (pid: string, amount: number) => { id: string; credits: number };
        }) => T,
      ) => Promise<T>;
    };
    const result = await sqliteRepo.runInTransaction((tx) => {
      tx.addCredits(player.id, 100);
      tx.withdrawCredits(player.id, 30);
      return tx.addCredits(player.id, 10);
    });
    expect(result.credits).toBe(580);
    expect(await repo.getBalance(player.id)).toBe(580);
  });

  it("runInTransaction rolls back every write when the callback throws", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-ROLLBACK",
      homeSystemId: "system-001",
    });
    const start = await repo.getBalance(player.id);
    const sqliteRepo = repo as unknown as {
      runInTransaction: <T>(
        fn: (tx: {
          addCredits: (pid: string, amount: number) => { id: string; credits: number };
          withdrawCredits: (pid: string, amount: number) => { id: string; credits: number };
        }) => T,
      ) => Promise<T>;
    };
    await expect(
      sqliteRepo.runInTransaction((tx) => {
        // First write succeeds.
        tx.addCredits(player.id, 100);
        // Second write succeeds too.
        tx.withdrawCredits(player.id, 50);
        // Third write would overdraw — throws, must roll back the
        // previous two writes.
        tx.withdrawCredits(player.id, 10_000);
        return "unreachable";
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await repo.getBalance(player.id)).toBe(start);
  });

  it("runInTransaction rolls back when a synthetic throw interrupts the callback", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "PILOT-MID-FAIL",
      homeSystemId: "system-001",
    });
    const start = await repo.getBalance(player.id);
    const sqliteRepo = repo as unknown as {
      runInTransaction: <T>(
        fn: (tx: {
          addCredits: (pid: string, amount: number) => { id: string; credits: number };
          withdrawCredits: (pid: string, amount: number) => { id: string; credits: number };
        }) => T,
      ) => Promise<T>;
    };
    await expect(
      sqliteRepo.runInTransaction((tx) => {
        tx.addCredits(player.id, 75);
        // Application-level invariant violated — e.g. the dock-sell
        // flow would throw after recording the cargo wipe. We model
        // that mid-flight failure here.
        throw new Error("audit log unavailable");
      }),
    ).rejects.toThrow(/audit log/i);
    expect(await repo.getBalance(player.id)).toBe(start);
  });
});

describe("credits — lookup errors", () => {
  it("getBalance throws NotFoundError for an unknown player id", async () => {
    const { repo } = active();
    await expect(repo.getBalance("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not found/i,
    );
  });
});
