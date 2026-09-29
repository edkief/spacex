/**
 * Canonical JSON serialization: recursively sorts object keys so the same
 * data always serializes identically, regardless of insertion order.
 * Used for stable checksums (galaxy determinism fixtures) and for
 * comparing structures across client/server.
 */

/** Serialize `value` as canonical JSON (sorted object keys). */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}
