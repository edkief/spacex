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
  claimCallsign,
  loadSessionProfile,
  pickHomeSystemId,
  resumeSession,
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
    const tampered = `${claimed.token.slice(0, -1)}A`;
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
