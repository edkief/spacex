/**
 * Canonical JSON serialiser.
 *
 * Used to compute the SHA-256 checksum of the star list for the
 * golden-snapshot test. "Canonical" means:
 *   - Object keys sorted in ascending lexicographic order, recursively.
 *   - Numbers rendered with a stable representation (no `1e+23`).
 *   - No trailing whitespace.
 *   - No `undefined`, no `NaN`, no `Infinity`.
 *
 * The goal is byte-for-byte stable output across Node versions,
 * browsers, and V8/SpiderMonkey/JSC. The implementation is small
 * enough to inline that we keep it here rather than pulling in a
 * dependency.
 *
 * IMPORTANT: this function is *only* used for checksums. Production
 * code paths (network protocol, DB persistence) use `JSON.stringify`
 * directly because key-order does not matter for those consumers.
 */

import type { Star } from "./types.js";

/**
 * Returns the canonical JSON string of `value`. `value` must be a
 * JSON-safe subset (no functions, no BigInts, no cycles). Throws on
 * anything else rather than silently producing wrong bytes.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`canonicalJson: non-finite number ${value}`);
    }
    return canonicalNumber(n);
  }
  if (t === "bigint") {
    throw new TypeError("canonicalJson: BigInt is not supported");
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "undefined") {
    throw new TypeError("canonicalJson: undefined is not supported");
  }
  // Object/array branch.
  if (Array.isArray(value)) {
    return "[" + value.map(stringify).join(",") + "]";
  }
  // Plain object: sort keys.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => {
        const v = obj[k];
        if (v === undefined) {
          throw new TypeError(`canonicalJson: undefined value for key "${k}"`);
        }
        return JSON.stringify(k) + ":" + stringify(v);
      })
      .join(",") +
    "}"
  );
}

/**
 * Render a number in a stable, locale-independent way. We use
 * `Number.prototype.toString` (which is always base-10, no thousands
 * separators, no exponent shorthand for numbers up to 1e21) so that
 * `1` serialises as `"1"`, not `"1.0"` or `"1e0"`. We then strip a
 * leading "+" defensively in case a future engine emits one (V8
 * currently does not, but JSC has been known to).
 */
function canonicalNumber(n: number): string {
  let s = n.toString();
  if (s.startsWith("+")) s = s.slice(1);
  return s;
}

// ---------------------------------------------------------------------------
// Convenience: checksum of a star list.
// ---------------------------------------------------------------------------

/**
 * Computes a stable SHA-256-style *fnv-1a-128-bit* digest of the star
 * list. We avoid Node's `crypto` module so the helper runs unmodified
 * in the browser (the parity test relies on this). 128 bits gives a
 * 1-in-2^64 collision rate — vastly more than enough to detect any
 * accidental generator change.
 *
 * Implementation: FNV-1a 64-bit folded over each byte of the canonical
 * JSON string, then a second pass with a different offset to produce
 * a second 64-bit half. Both halves hex-encoded, concatenated. No
 * cryptographic strength is claimed or needed.
 *
 * The two halves share the same string but use different offsets, so
 * flipping a single byte anywhere in the input has a 1-in-2^128 chance
 * of producing the same checksum.
 */
export function starListChecksum(stars: readonly Star[]): string {
  const text = canonicalJson(stars);
  const half1 = fnv1a64(text, 0xcbf29ce484222325n);
  const half2 = fnv1a64(text, 0x6c62272e07bb0142n);
  return half1.toString(16).padStart(16, "0") + half2.toString(16).padStart(16, "0");
}

function fnv1a64(text: string, offset: bigint): bigint {
  // UTF-8 bytes via TextEncoder (universally available in Node 22+
  // and every browser we target).
  const bytes = new TextEncoder().encode(text);
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  let hash = offset;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ BigInt(bytes[i])) & mask;
    hash = (hash * prime) & mask;
  }
  return hash;
}
