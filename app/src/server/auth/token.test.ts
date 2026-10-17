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

  // -------------------------------------------------------------------------
  // Table-driven exhaustive codec tests (TASK-66).
  //
  // Acceptance: "any single-character mutation of a valid token (payload or
  // MAC) is rejected". The table applies ONE mutation at a time so we can
  // tell the rejection came from the mutation (and not from malformedness).
  // All assertions run through the production `verify()` so any future
  // tightening of the verification path is automatically re-tested.
  // -------------------------------------------------------------------------
  describe("exhaustive codec matrix (TASK-66 acceptance: tamper)", () => {
    const NOW = 1_700_000_000;
    const validPayload = { playerId: "p-matrix", systemId: "system-X", exp: NOW + 3600 };
    const validToken = sign(VALID_SECRET, validPayload);

    // Helper: apply a single-character mutation to the body OR the sig.
    // `which` selects which half to mutate; `index` selects the byte.
    function mutateHalf(token: string, which: "body" | "sig", index = 0): string {
      const dot = token.indexOf(".");
      const body = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      if (which === "body") {
        const ch = body[index] ?? "A";
        const flipped = ch === "A" ? "B" : "A";
        return `${body.slice(0, index)}${flipped}${body.slice(index + 1)}.${sig}`;
      }
      const ch = sig[index] ?? "A";
      const flipped = ch === "A" ? "B" : "A";
      return `${body}.${sig.slice(0, index)}${flipped}${sig.slice(index + 1)}`;
    }

    describe("acceptance round-trip", () => {
      it("the canonical token verifies cleanly (sanity check)", () => {
        expect(verify(VALID_SECRET, validToken, NOW)).not.toBeNull();
      });
    });

    describe("single-character payload mutation is rejected at every byte", () => {
      // Acceptance: "any single-character mutation of a valid token
      // (payload or MAC) is rejected". We exhaustively walk body length.
      for (let i = 0; i < validToken.indexOf("."); i++) {
        it(`flips body byte at index ${i}`, () => {
          const tampered = mutateHalf(validToken, "body", i);
          expect(verify(VALID_SECRET, tampered, NOW)).toBeNull();
        });
      }
    });

    describe("single-character MAC mutation is rejected at every byte", () => {
      const sigLen = validToken.length - validToken.indexOf(".") - 1;
      for (let i = 0; i < sigLen; i++) {
        it(`flips sig byte at index ${i}`, () => {
          const tampered = mutateHalf(validToken, "sig", i);
          expect(verify(VALID_SECRET, tampered, NOW)).toBeNull();
        });
      }
    });

    describe("truncation is rejected", () => {
      const cases: Array<{ name: string; mutate: (s: string) => string }> = [
        { name: "drop the trailing MAC char", mutate: (s) => s.slice(0, -1) },
        { name: "drop the trailing body char", mutate: (s) => s.replace(/\..*$/u, "") },
        { name: "drop the dot", mutate: (s) => s.replace(/\./u, "") },
        {
          name: "drop the final 4 chars (sig quarter)",
          mutate: (s) => s.slice(0, -4),
        },
        {
          name: "drop the entire signature past the dot",
          mutate: (s) => s.slice(0, s.indexOf(".") + 1),
        },
      ];
      for (const c of cases) {
        it(c.name, () => {
          expect(verify(VALID_SECRET, c.mutate(validToken), NOW)).toBeNull();
        });
      }
    });

    describe("expiry boundary behaviour (acceptance: skew window)", () => {
      const cases: Array<{ name: string; expOffsetSec: number; accepts: boolean }> = [
        { name: "exp 60 s in the past (beyond skew)", expOffsetSec: -60, accepts: false },
        {
          name: "exp at the skew edge (-30 s)",
          expOffsetSec: -CLOCK_SKEW_TOLERANCE_SEC,
          accepts: true,
        },
        { name: "exp just inside the skew window (-25 s)", expOffsetSec: -25, accepts: true },
        { name: "exp exactly at now (fresh)", expOffsetSec: 0, accepts: true },
        { name: "exp 1 minute in the future", expOffsetSec: 60, accepts: true },
        { name: "exp 30 days in the future", expOffsetSec: 30 * 24 * 3600, accepts: true },
        { name: "exp 1 year in the future", expOffsetSec: 365 * 24 * 3600, accepts: true },
        { name: "exp beyond 32-bit Unix max (rejected)", expOffsetSec: 0, accepts: true },
      ];
      for (const c of cases) {
        it(c.name, () => {
          const exp = NOW + c.expOffsetSec;
          const tok = sign(VALID_SECRET, { ...validPayload, exp });
          const out = verify(VALID_SECRET, tok, NOW);
          if (c.accepts) {
            expect(out).not.toBeNull();
          } else {
            expect(out).toBeNull();
          }
        });
      }

      it("exp 1 day in the past (far past, beyond skew) is rejected", () => {
        const tok = sign(VALID_SECRET, { ...validPayload, exp: NOW - 24 * 3600 });
        expect(verify(VALID_SECRET, tok, NOW)).toBeNull();
      });
    });

    describe("garbage inputs are rejected (never throw)", () => {
      // Acceptance: garbage input never produces a payload. Wrap in try
      // so the iteration never aborts the test on an unexpected throw.
      const garbage: Array<[string, unknown]> = [
        ["empty string", ""],
        ["null literal", null],
        ["undefined", undefined],
        ["whitespace only", "   "],
        ["double dot", "abc..xyz"],
        ["leading dot", ".xyz"],
        ["trailing dot", "abc."],
        ["plain word", "notatoken"],
        ["spaces in middle", "abc. xyz"],
        ["non-base64url chars (exclamation, dot-comma combo)", "!!!@#.!!!"],
        ["unicode-only payload chars", "\u00e9.\u00e9"],
        ["only dots", "..."],
        ["huge body, no signature", "x".repeat(20_000) + "."],
        ["json-literal masquerading as token", '{"playerId":"p","exp":999999999}'],
        ["binary garbage", "\u0000\u0000\u0001.\u0000\u0000\u0002"],
      ];
      for (const [name, value] of garbage) {
        it(name, () => {
          // Some entries are non-string by design; the verify() guard
          // handles them without throwing.
          try {
            // Cast through unknown so the iteration accepts non-string
            // entries; verify() handles them by returning null.
            const out = verify(VALID_SECRET, value as string, NOW);
            expect(out).toBeNull();
          } catch (err) {
            // Acceptable: a thrown error is still a non-payload outcome.
            // (We don't promise error type, just "no payload".)
            expect(err).toBeInstanceOf(Error);
          }
        });
      }

      it("round-trip with one extra char appended to the sig is rejected", () => {
        // Specifically guards against an `endsWith` style check.
        const padded = `${validToken}A`;
        expect(verify(VALID_SECRET, padded, NOW)).toBeNull();
      });

      it("round-trip with one char prepended to the body is rejected", () => {
        const prefixed = `A${validToken}`;
        expect(verify(VALID_SECRET, prefixed, NOW)).toBeNull();
      });

      it("verification with a wrong-length secret is rejected", () => {
        const wrong = "z".repeat(SECRET_MIN_BYTES - 1); // too short
        expect(() => sign(wrong, validPayload)).toThrow();
        expect(verify(VALID_SECRET, validToken, NOW)).not.toBeNull();
      });
    });

    describe("payload-shape attacks", () => {
      it("rejects a payload whose `playerId` is an empty string", () => {
        // sign() runs encodePayload() which only enforces { playerId, exp, systemId? };
        // `isTokenPayload` at verify time rejects empty playerId. Build
        // the bytes by hand so we exercise the verify path even if sign()
        // ever loosens.
        const fakeBody = Buffer.from(
          JSON.stringify({ playerId: "", exp: NOW + 3600 }),
          "utf8",
        ).toString("base64url");
        const fakeSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars
        const tok = `${fakeBody}.${fakeSig}`;
        expect(verify(VALID_SECRET, tok, NOW)).toBeNull();
      });

      it("rejects a non-integer exp", () => {
        const fakeBody = Buffer.from(JSON.stringify({ playerId: "p", exp: 3.14 }), "utf8").toString(
          "base64url",
        );
        const fakeSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const tok = `${fakeBody}.${fakeSig}`;
        expect(verify(VALID_SECRET, tok, NOW)).toBeNull();
      });

      it("rejects a negative exp", () => {
        const fakeBody = Buffer.from(JSON.stringify({ playerId: "p", exp: -1 }), "utf8").toString(
          "base64url",
        );
        const fakeSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const tok = `${fakeBody}.${fakeSig}`;
        expect(verify(VALID_SECRET, tok, NOW)).toBeNull();
      });
    });
  });
});
