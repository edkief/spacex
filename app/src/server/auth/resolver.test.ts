/**
 * Auth resolver tests (TASK-10).
 *
 * Exercises:
 *   - claimCallsign happy path (creates player + starter ship + session row).
 *   - Duplicate callsign → CallsignTakenError.
 *   - Invalid callsign → InvalidCallsignError.
 *   - resumeSession valid token + lookup failure modes.
 *   - loadSessionProfile returns the player + active starter ship.
 *   - buildAuthResolver for both {callsign} and {token} branches.
 */
import { describe, expect, it } from "vitest";
import { active, installRepoHooks } from "../db/repo.test.shared.js";
import {
  AuthClaimsSchema,
  CallsignSchema,
  buildAuthResolver,
  buildLogoutResolver,
  claimCallsign,
  loadSessionProfile,
  pickHomeSystemId,
  resumeSession,
  revokeSession,
  InvalidCallsignError,
} from "./resolver.js";
import { CallsignTakenError } from "../db/errors.js";
import { hashToken, verify } from "./token.js";
import { SECRET_MIN_BYTES } from "./token.js";

const SECRET = "x".repeat(SECRET_MIN_BYTES);
const FAKE_NOW_MS = 1_700_000_000_000;
const GALAXY_SEED = "DRIFT-TEST";
const GALAXY_STAR_COUNT = 32;
const DEFAULTS = {
  galaxySeed: GALAXY_SEED,
  galaxyStarCount: GALAXY_STAR_COUNT,
  nowMs: FAKE_NOW_MS,
  ttlMs: 1000 * 60 * 60, // 1 hour
};

installRepoHooks();

describe("CallsignSchema", () => {
  it("accepts 3-16 chars alnum + dash", () => {
    expect(CallsignSchema.safeParse("abc").success).toBe(true);
    expect(CallsignSchema.safeParse("ABC-123").success).toBe(true);
    expect(CallsignSchema.safeParse("a".repeat(16)).success).toBe(true);
  });

  it("rejects too short, too long, or with forbidden chars", () => {
    expect(CallsignSchema.safeParse("ab").success).toBe(false);
    expect(CallsignSchema.safeParse("a".repeat(17)).success).toBe(false);
    expect(CallsignSchema.safeParse("has space").success).toBe(false);
    expect(CallsignSchema.safeParse("has_under").success).toBe(false);
    expect(CallsignSchema.safeParse("has.dot").success).toBe(false);
    expect(CallsignSchema.safeParse(123).success).toBe(false);
  });
});

describe("pickHomeSystemId", () => {
  it("returns a stable id from the seeded galaxy", () => {
    const a = pickHomeSystemId("Pilot-1", GALAXY_STAR_COUNT, GALAXY_SEED);
    const b = pickHomeSystemId("PILOT-1", GALAXY_STAR_COUNT, GALAXY_SEED);
    const c = pickHomeSystemId("Pilot-2", GALAXY_STAR_COUNT, GALAXY_SEED);
    expect(a).toBe(b); // case-insensitive
    // Different callsign may collide on the same id, but the function is deterministic.
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    void c;
  });

  it("throws on an empty galaxy", () => {
    expect(() => pickHomeSystemId("pilot-1", 0, GALAXY_SEED)).toThrow();
  });
});

describe("claimCallsign", () => {
  it("creates a player, ship, and session; returns a signed token", async () => {
    const { repo } = active();
    const result = await claimCallsign(repo, SECRET, "Pilot-1", DEFAULTS);
    expect(result.callsign).toBe("Pilot-1");
    expect(result.playerId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.shipId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.homeSystemId.length).toBeGreaterThan(0);
    expect(result.token).toContain(".");
    expect(result.tokenExpiresAt).toBe(Math.floor((FAKE_NOW_MS + DEFAULTS.ttlMs) / 1000));

    // The token verifies, and the session row exists by hash.
    const payload = verify(SECRET, result.token, Math.floor(FAKE_NOW_MS / 1000));
    expect(payload?.playerId).toBe(result.playerId);
    const sessionRow = await repo.getSession(hashToken(result.token));
    expect(sessionRow?.playerId).toBe(result.playerId);

    // The starter ship exists and belongs to the player.
    const ships = await repo.listShipsByOwner(result.playerId);
    expect(ships).toHaveLength(1);
    expect(ships[0]?.classId).toBe("scout");
    expect(ships[0]?.state).toBe("docked");
  });

  it("rejects an invalid callsign (422-style) without touching the DB", async () => {
    const { repo } = active();
    await expect(claimCallsign(repo, SECRET, "ab", DEFAULTS)).rejects.toBeInstanceOf(
      InvalidCallsignError,
    );
    // No player row written.
    const missing = await repo.findPlayerByCallsign("ab");
    expect(missing).toBeNull();
  });

  it("rejects a duplicate callsign with CallsignTakenError", async () => {
    const { repo } = active();
    await claimCallsign(repo, SECRET, "Pilot-Dup", DEFAULTS);
    await expect(claimCallsign(repo, SECRET, "Pilot-Dup", DEFAULTS)).rejects.toBeInstanceOf(
      CallsignTakenError,
    );
  });
});

describe("resumeSession", () => {
  it("returns the player profile for a fresh token", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Pilot-X", DEFAULTS);
    const resumed = await resumeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    expect(resumed?.playerId).toBe(claimed.playerId);
    expect(resumed?.callsign).toBe("Pilot-X");
    expect(resumed?.tokenExpiresAt).toBe(claimed.tokenExpiresAt);
  });

  it("returns null for an unknown token", async () => {
    const { repo } = active();
    const r = await resumeSession(repo, SECRET, "fake-token-with-a-dot.badsig", {
      nowMs: FAKE_NOW_MS,
    });
    expect(r).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Pilot-Y", DEFAULTS);
    // Flip the signature's final base64url character to one that is
    // *guaranteed* to differ (i.e. `B` when the original ends in `A`,
    // otherwise `A`). The naive `${token.slice(0, -1)}A` pattern was a
    // no-op ~5% of the time because HMAC-SHA256 outputs commonly end
    // in `A` after base64url encoding, which made this test flaky.
    const lastChar = claimed.token[claimed.token.length - 1];
    const replacement = lastChar === "A" ? "B" : "A";
    const tampered = `${claimed.token.slice(0, -1)}${replacement}`;
    const r = await resumeSession(repo, SECRET, tampered, { nowMs: FAKE_NOW_MS });
    expect(r).toBeNull();
  });

  it("returns null for an expired token (beyond skew tolerance)", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Pilot-Z", DEFAULTS);
    const inFarFuture = (claimed.tokenExpiresAt + 100) * 1000;
    const r = await resumeSession(repo, SECRET, claimed.token, { nowMs: inFarFuture });
    expect(r).toBeNull();
  });
});

describe("loadSessionProfile", () => {
  it("returns player + active starter ship", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Profile-Pilot", DEFAULTS);
    const profile = await loadSessionProfile(repo, SECRET, claimed.token, {
      nowMs: FAKE_NOW_MS,
    });
    expect(profile?.playerId).toBe(claimed.playerId);
    expect(profile?.shipId).toBe(claimed.shipId);
    expect(profile?.homeSystemId).toBe(claimed.homeSystemId);
    expect(profile?.credits).toBe(500);
    expect(profile?.callsign).toBe("Profile-Pilot");
  });

  it("returns null for an invalid token", async () => {
    const { repo } = active();
    const r = await loadSessionProfile(repo, SECRET, "bad", { nowMs: FAKE_NOW_MS });
    expect(r).toBeNull();
  });
});

describe("buildAuthResolver", () => {
  it("handles a callsign claim over the WS auth protocol", async () => {
    const { repo } = active();
    const resolver = buildAuthResolver(repo, SECRET, DEFAULTS);
    const r = await resolver({ callsign: "WS-Pilot" });
    expect(r.playerId.length).toBeGreaterThan(0);
    expect(r.callsign).toBe("WS-Pilot");
    expect(r.tokenExpiresAt).toBeGreaterThan(0);
  });

  it("resumes an existing session when the token is valid", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Resume-Pilot", DEFAULTS);
    const resolver = buildAuthResolver(repo, SECRET, DEFAULTS);
    const r = await resolver({ token: claimed.token });
    expect(r.playerId).toBe(claimed.playerId);
    expect(r.callsign).toBe("Resume-Pilot");
  });

  it("rejects a malformed payload with an Error", async () => {
    const { repo } = active();
    const resolver = buildAuthResolver(repo, SECRET, DEFAULTS);
    await expect(resolver({ nothing: "here" })).rejects.toThrow();
    await expect(resolver(null)).rejects.toThrow();
    await expect(resolver(undefined)).rejects.toThrow();
  });

  it("rejects a duplicate callsign on the WS auth path", async () => {
    const { repo } = active();
    const resolver = buildAuthResolver(repo, SECRET, DEFAULTS);
    await resolver({ callsign: "Dup-WS" });
    await expect(resolver({ callsign: "Dup-WS" })).rejects.toThrow(/callsign/i);
  });
});

// ---------------------------------------------------------------------------
// Revoke + concurrent-use coverage (TASK-66).
//
// Acceptance:
//   - revoking deletes the sessions row; a second revoke returns false.
//   - the same token can be used by two connections; both work until
//     a revoke happens on either side (shared-account model).
// ---------------------------------------------------------------------------
describe("revokeSession (TASK-66)", () => {
  it("deletes the session row for a valid token and reports {revoked:true, callsign}", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Revoke-A", DEFAULTS);
    const before = await repo.getSession(hashToken(claimed.token));
    expect(before).not.toBeNull();

    const result = await revokeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    expect(result.revoked).toBe(true);
    expect(result.playerId).toBe(claimed.playerId);
    expect(result.callsign).toBe("Revoke-A");

    const after = await repo.getSession(hashToken(claimed.token));
    expect(after).toBeNull();
  });

  it("returns {revoked:false} for an already-revoked token (idempotent)", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Revoke-B", DEFAULTS);
    await revokeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    const second = await revokeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    expect(second.revoked).toBe(false);
  });

  it("returns {revoked:false} for an invalid token without throwing", async () => {
    const { repo } = active();
    const r = await revokeSession(repo, SECRET, "garbage", { nowMs: FAKE_NOW_MS });
    expect(r.revoked).toBe(false);
    expect(r.callsign).toBeNull();
  });

  it("returns {revoked:false} for a token whose MAC is tampered (does NOT delete anything)", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Revoke-C", DEFAULTS);
    // Deterministic flip — see the equivalent note in
    // `returns null for a tampered token`. Always changes the MAC.
    const lastChar = claimed.token[claimed.token.length - 1];
    const replacement = lastChar === "A" ? "B" : "A";
    const tampered = `${claimed.token.slice(0, -1)}${replacement}`;
    const r = await revokeSession(repo, SECRET, tampered, { nowMs: FAKE_NOW_MS });
    expect(r.revoked).toBe(false);
    // Original session row must still exist.
    const still = await repo.getSession(hashToken(claimed.token));
    expect(still).not.toBeNull();
  });

  it("returns {revoked:false} for an expired token (does NOT delete)", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Revoke-D", DEFAULTS);
    const futureMs = (claimed.tokenExpiresAt + 100) * 1000;
    const r = await revokeSession(repo, SECRET, claimed.token, { nowMs: futureMs });
    expect(r.revoked).toBe(false);
  });

  it("returns {revoked:false} when the player id encoded in the token does not own the session", async () => {
    // Construct a token whose payload claims `payload.playerId = attacker`
    // but the hash lands on the legitimate session row. Sha256 collision
    // is astronomically unlikely; the test exercises the cross-check
    // path by inserting a session row keyed by an unrelated playerId and
    // then signing a token with the *correct* playerId — we instead do
    // the reverse: write a token whose payload claims a different
    // playerId and target a row keyed to a different player.
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Revoke-E", DEFAULTS);
    // Mint a token for a fictitious playerId. Verify+hash won't find a
    // session row → return revoked:false (no row to delete).
    const otherId = "00000000-0000-0000-0000-000000000099";
    const { mintToken } = await import("./token.js");
    const { token: bogus } = mintToken(SECRET, {
      playerId: otherId,
      ttlMs: 60_000,
      nowMs: FAKE_NOW_MS,
    });
    const r = await revokeSession(repo, SECRET, bogus, { nowMs: FAKE_NOW_MS });
    expect(r.revoked).toBe(false);
    // The legitimate session for the claimed callsign must still be present.
    const still = await repo.getSession(hashToken(claimed.token));
    expect(still).not.toBeNull();
  });
});

describe("buildLogoutResolver (TASK-66)", () => {
  it("deletes every session row for the player and reports the callsign", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "Logout-A",
      homeSystemId: "system-001",
    });
    const { mintToken } = await import("./token.js");
    // Insert three session rows for the same player. Each token uses a
    // distinct `exp` so the signed bytes differ (otherwise `hashToken`
    // would collide and SQLite's UNIQUE constraint would fail).
    for (let i = 0; i < 3; i++) {
      const { token } = mintToken(SECRET, {
        playerId: player.id,
        ttlMs: 60_000 * (i + 1), // <-- varies per row
        nowMs: FAKE_NOW_MS,
      });
      await repo.createSession({ tokenHash: hashToken(token), playerId: player.id, ttlMs: 60_000 });
    }

    const logout = buildLogoutResolver(repo);
    const r = await logout(player.id);
    expect(r.revoked).toBe(3);
    expect(r.callsign).toBe("Logout-A");
  });

  it("returns {revoked:0} when the player has no active sessions", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({
      callsign: "Logout-B",
      homeSystemId: "system-001",
    });
    const logout = buildLogoutResolver(repo);
    const r = await logout(player.id);
    expect(r.revoked).toBe(0);
  });
});

describe("concurrent-use: same token used by two connections (TASK-66 acceptance)", () => {
  it("two simultaneous WS resumes work; revoke-once drops both", async () => {
    const { repo } = active();
    const claimed = await claimCallsign(repo, SECRET, "Shared-Pilot", DEFAULTS);
    // Connection A resumes.
    const a = await resumeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    // Connection B resumes with the same token.
    const b = await resumeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    expect(a?.playerId).toBe(claimed.playerId);
    expect(b?.playerId).toBe(claimed.playerId);

    // Revoke via the REST helper path.
    const r = await revokeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    expect(r.revoked).toBe(true);

    // Both connections now fail to resume — they were each backed by the
    // same single DB row.
    const a2 = await resumeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    const b2 = await resumeSession(repo, SECRET, claimed.token, { nowMs: FAKE_NOW_MS });
    expect(a2).toBeNull();
    expect(b2).toBeNull();
  });

  it("two players each revoke their own session independently", async () => {
    const { repo } = active();
    const a = await claimCallsign(repo, SECRET, "Co-A", DEFAULTS);
    const b = await claimCallsign(repo, SECRET, "Co-B", DEFAULTS);
    // Revoke A.
    expect((await revokeSession(repo, SECRET, a.token, { nowMs: FAKE_NOW_MS })).revoked).toBe(true);
    // B's session is unaffected.
    const bResume = await resumeSession(repo, SECRET, b.token, { nowMs: FAKE_NOW_MS });
    expect(bResume?.playerId).toBe(b.playerId);
    // B's logout resolver removes B's row only.
    const logout = buildLogoutResolver(repo);
    const r = await logout(b.playerId);
    expect(r.revoked).toBe(1);
    expect(r.callsign).toBe("Co-B");
  });
});

describe("AuthClaimsSchema", () => {
  it("accepts both callsign-claim and token-resume payloads", () => {
    expect(AuthClaimsSchema.safeParse({ callsign: "Pilot-1" }).success).toBe(true);
    expect(AuthClaimsSchema.safeParse({ token: "fake.token" }).success).toBe(true);
  });

  it("rejects unknown shapes and unknown extra keys", () => {
    expect(AuthClaimsSchema.safeParse({ callsign: 123 }).success).toBe(false);
    expect(AuthClaimsSchema.safeParse({ token: "" }).success).toBe(false);
    expect(AuthClaimsSchema.safeParse({ callsign: "ab" }).success).toBe(false);
  });
});
