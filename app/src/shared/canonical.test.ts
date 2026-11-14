import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, canonicalStringify } from '@shared/canonical.ts';

describe('canonicalJson', () => {
  it('sorts keys at every depth and emits no whitespace', () => {
    const value = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
    expect(canonicalJson(value)).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('formats numbers in shortest round-trip form', () => {
    expect(canonicalJson([0, 1, -1, 0.1, 1.5e-7, 123456789012, 1e21])).toBe(
      '[0,1,-1,0.1,1.5e-7,123456789012,1e+21]',
    );
  });

  it('handles null, booleans, strings with escapes, and empty containers', () => {
    expect(canonicalJson({ n: null, t: true, s: 'a"\n', e: [], o: {} })).toBe(
      '{"e":[],"n":null,"o":{},"s":"a\\"\\n","t":true}',
    );
  });

  it.each([
    ['NaN', Number.NaN, /non-finite/],
    ['Infinity', Number.POSITIVE_INFINITY, /non-finite/],
    ['-Infinity', Number.NEGATIVE_INFINITY, /non-finite/],
    ['-0', -0, /negative zero/],
    ['undefined', undefined, /undefined/],
    ['bigint', 1n, /unsupported type bigint/],
    ['function', () => 1, /unsupported type function/],
    ['symbol', Symbol('x'), /unsupported type symbol/],
  ])('rejects %s loudly', (_label, value, message) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(value)).toThrow(message);
  });

  it('names the path of the offending nested value', () => {
    expect(() => canonicalJson({ a: [1, { b: Number.NaN }] })).toThrow(/a\[1\]\.b/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/: a: undefined/);
    expect(() => canonicalJson([1, , 3])).toThrow(/\[1\]/); // eslint-disable-line no-sparse-arrays
  });

  it('rejects non-plain objects and cycles', () => {
    expect(() => canonicalJson(new Map())).toThrow(/plain object/);
    expect(() => canonicalJson(new Date(0))).toThrow(/plain object/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
  });
});

describe('canonicalStringify', () => {
  it('pretty-prints with the same ordering and parses back identically', () => {
    const value = { b: [1, 2], a: { c: 1 } };
    const text = canonicalStringify(value, 2);
    expect(text).toBe('{\n  "a": {\n    "c": 1\n  },\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(canonicalJson(JSON.parse(text))).toBe(canonicalJson(value));
  });
});
