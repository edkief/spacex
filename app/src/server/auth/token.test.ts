/**
 * Token codec tests (TASK-10).
 *
 * Covers:
 *   - Round-trip sign/verify.
 *   - Expired tokens rejected (with 30 s clock-skew tolerance).
 *   - Modified payload fails MAC check.
 *   - Modified MAC fails verification.
 *   - Bad MAC length never returns a payload.
 *   - Mint-time `exp` is correct (relative to a fake clock).
 *   - `hashToken` is stable and distinct per token.
 *   - Secret length is enforced (>= 32 bytes).
 */
import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_TOLERANCE_SEC,
  DEFAULT_TTL_MS,
  SECRET_MIN_BYTES,
  assertValidSecret,
  hashToken,
  mintToken,
  sign,
  verify,
  verifyOrThrow,
  TokenVerificationError,
} from "./token.js";

const VALID_SECRET = "a".repeat(SECRET_MIN_BYTES); // 32 bytes UTF-8.

describe("token codec", () => {
  describe("assertValidSecret", () => {
    it("accepts secrets at exactly the minimum length", () => {
      expect(() => assertValidSecret(VALID_SECRET)).not.toThrow();
    });

    it("rejects an empty secret", () => {
      expect(() => assertValidSecret("")).toThrow();
    });

    it("rejects secrets shorter than SECRET_MIN_BYTES", () => {
      expect(() => assertValidSecret("a".repeat(SECRET_MIN_BYTES - 1))).toThrow();
    });
  });

  describe("sign + verify", () => {
    it("round-trips a payload", () => {
      const payload = { playerId: "p-123", systemId: "system-A", exp: 9_999_999 };
      const token = sign(VALID_SECRET, payload);
      const parsed = verify(VALID_SECRET, token, 5_000_000);
      expect(parsed).not.toBeNull();
      expect(parsed?.playerId).toBe("p-123");
      expect(parsed?.systemId).toBe("system-A");
      expect(parsed?.exp).toBe(9_999_999);
    });

    it("rejects an expired token beyond the skew tolerance", () => {
      const nowSec = 1_000_000;
      const token = sign(VALID_SECRET, { playerId: "p-1", exp: nowSec - 100 });
      expect(verify(VALID_SECRET, token, nowSec)).toBeNull();
    });

    it("accepts a token expired within the skew tolerance", () => {
      const nowSec = 1_000_000;
      const token = sign(VALID_SECRET, {
        playerId: "p-1",
        exp: nowSec - (CLOCK_SKEW_TOLERANCE_SEC - 5),
      });
      expect(verify(VALID_SECRET, token, nowSec)).not.toBeNull();
    });

    it("accepts a token whose exp is in the future", () => {
      const nowSec = 1_000_000;
      const token = sign(VALID_SECRET, { playerId: "p-1", exp: nowSec + 60 });
      expect(verify(VALID_SECRET, token, nowSec)).not.toBeNull();
    });

    it("rejects a token whose MAC has been tampered with", () => {
      const token = sign(VALID_SECRET, { playerId: "p-1", exp: 9_999_999 });
      // flip last char of signature
      const lastChar = token[token.length - 1];
      const flipped = lastChar === "A" ? "B" : "A";
      const corrupted = `${token.slice(0, -1)}${flipped}`;
      expect(verify(VALID_SECRET, corrupted, 5_000_000)).toBeNull();
    });

    it("rejects a token whose payload has been tampered with", () => {
      const token = sign(VALID_SECRET, { playerId: "p-1", exp: 9_999_999 });
      const dot = token.indexOf(".");
      const bodyB64 = token.slice(0, dot);
      const sigB64 = token.slice(dot + 1);
      // Replace body with a different payload (still valid JSON), keep the
      // original signature — must fail MAC check.
      const tampered = `${Buffer.from('{"playerId":"p-2","exp":1}', "utf8").toString("base64url")}.${sigB64}`;
      expect(verify(VALID_SECRET, tampered, 5_000_000)).toBeNull();
      // Also confirm a token signed with a different secret is rejected
      expect(verify("z".repeat(SECRET_MIN_BYTES), token, 5_000_000)).toBeNull();
      void bodyB64;
    });

    it("rejects a malformed token", () => {
      expect(verify(VALID_SECRET, "", 0)).toBeNull();
      expect(verify(VALID_SECRET, "no-dot", 0)).toBeNull();
      expect(verify(VALID_SECRET, ".only-dot.", 0)).toBeNull();
      // Non-base64url payload.
      expect(verify(VALID_SECRET, "!!!!.zzzz", 0)).toBeNull();
    });

    it("uses constant-time MAC compare (different lengths never match)", () => {
      const valid = sign(VALID_SECRET, { playerId: "p-1", exp: 9_999_999 });
      // Truncate the MAC section.
      const dot = valid.indexOf(".");
      const truncated = valid.slice(0, dot + 2);
      expect(verify(VALID_SECRET, truncated, 5_000_000)).toBeNull();
    });

    it("verifyOrThrow throws on invalid tokens", () => {
      expect(() => verifyOrThrow(VALID_SECRET, "bad-token", 0)).toThrow(TokenVerificationError);
      expect(() =>
        verifyOrThrow(VALID_SECRET, sign(VALID_SECRET, { playerId: "p", exp: 1 }), 9_999_999),
      ).toThrow(TokenVerificationError);
    });

    it("supports a null systemId payload", () => {
      const token = sign(VALID_SECRET, { playerId: "p-1", systemId: null, exp: 9_999_999 });
      const parsed = verify(VALID_SECRET, token, 5_000_000);
      expect(parsed?.playerId).toBe("p-1");
      expect(parsed?.systemId).toBeNull();
    });
  });

  describe("mintToken", () => {
    it("stamps exp relative to nowMs", () => {
      const { exp, token } = mintToken(VALID_SECRET, {
        playerId: "p-1",
        nowMs: 1_700_000_000_000,
        ttlMs: 60_000,
      });
      expect(exp).toBe(Math.floor((1_700_000_000_000 + 60_000) / 1000));
      const parsed = verify(VALID_SECRET, token, Math.floor(1_700_000_000_000 / 1000));
      expect(parsed?.playerId).toBe("p-1");
    });

    it("uses DEFAULT_TTL_MS when ttlMs is omitted", () => {
      const before = Math.floor(Date.now() / 1000);
      const { exp } = mintToken(VALID_SECRET, { playerId: "p-1" });
      const after = Math.floor(Date.now() / 1000);
      expect(exp).toBeGreaterThanOrEqual(before + Math.floor(DEFAULT_TTL_MS / 1000) - 1);
      expect(exp).toBeLessThanOrEqual(after + Math.floor(DEFAULT_TTL_MS / 1000) + 1);
    });
  });

  describe("hashToken", () => {
    it("is deterministic and length-aware", () => {
      expect(hashToken("hello")).toBe(hashToken("hello"));
      expect(hashToken("hello")).not.toBe(hashToken("world"));
      // 64 hex chars.
      expect(hashToken("hello")).toMatch(/^[0-9a-f]{64}$/u);
    });
  });
});
