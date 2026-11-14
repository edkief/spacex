import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SHARED = path.join(import.meta.dirname, '../../src/shared');

const FORBIDDEN: [RegExp, string][] = [
  [/\bMath\.(random|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|asinh|acosh|atanh)\b/, 'Math trig'],
  [/\bMath\.(log|log2|log10|log1p|exp|expm1|pow|cbrt|hypot)\b/, 'Math exp/log/pow'],
  [/\bDate\b/, 'Date'],
  [/\bcrypto\b/, 'crypto'],
  [/\bperformance\.now\b/, 'performance.now'],
  [/\*\*/, '** operator'],
];

/** Lists non-test .ts files under `dir` recursively. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__fixtures__' ? [] : sourceFiles(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** Strips comments so documentation may mention banned names without tripping the scan. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('determinism source guard', () => {
  const files = [path.join(SHARED, 'random.ts'), ...sourceFiles(path.join(SHARED, 'galaxy'))];

  it('covers the expected files', () => {
    expect(files.some((file) => file.endsWith('random.ts'))).toBe(true);
  });

  it.each(files.map((file) => [path.relative(SHARED, file), file] as const))(
    '%s uses no engine-dependent or non-deterministic APIs',
    (_name, file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const [pattern, label] of FORBIDDEN) {
        expect(pattern.test(code), `${label} found`).toBe(false);
      }
    },
  );
});
