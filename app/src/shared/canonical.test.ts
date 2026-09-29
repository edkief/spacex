/**
 * TASK-6 step 1: canonical JSON helper — stable key order and number
 * formatting make fixture comparisons platform-stable.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order (order is semantic, not key order)', () => {
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
    expect(canonicalJson([{ z: 1, a: 2 }, { b: 3 }])).toBe('[{"a":2,"z":1},{"b":3}]');
  });

  it('serializes the same data identically regardless of insertion order', () => {
    const a = { x: 1, y: [1, { k: 'v', j: true }], z: null };
    const b = { z: null, y: [1, { j: true, k: 'v' }], x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('uses consistent number formatting', () => {
    expect(canonicalJson({ pi: 3.14, zero: 0, neg: -1.5, big: 1e21 })).toBe(
      '{"big":1e+21,"neg":-1.5,"pi":3.14,"zero":0}',
    );
  });

  it('handles strings (escapes) and primitives', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('')).toBe('""');
  });
});
