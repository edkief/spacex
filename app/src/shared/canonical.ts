/** Thrown when a value cannot be serialised canonically; the message names the offending path. */
export class CanonicalJsonError extends Error {
  constructor(path: string, reason: string) {
    super(`canonical JSON: ${path || '<root>'}: ${reason}`);
    this.name = 'CanonicalJsonError';
  }
}

/** True for plain objects (prototype Object.prototype or null); rejects Map, Date, classes, etc. */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Serialises a primitive, or throws for values JSON cannot represent faithfully. */
function primitive(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, `non-finite number`);
      if (Object.is(value, -0)) throw new CanonicalJsonError(path, 'negative zero');
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalJsonError(path, 'undefined');
    default:
      throw new CanonicalJsonError(path, `unsupported type ${typeof value}`);
  }
}

/** Recursive worker: `indent` 0 gives compact output, otherwise pretty with that many spaces. */
function write(
  value: unknown,
  indent: number,
  depth: number,
  path: string,
  stack: readonly object[],
): string {
  if (typeof value !== 'object' || value === null) return primitive(value, path);
  if (stack.includes(value)) throw new CanonicalJsonError(path, 'circular reference');
  const nested = [...stack, value];
  const pad = indent > 0 ? '\n' + ' '.repeat(indent * (depth + 1)) : '';
  const close = indent > 0 ? '\n' + ' '.repeat(indent * depth) : '';
  const colon = indent > 0 ? ': ' : ':';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      items.push(write(value[i], indent, depth + 1, `${path}[${i}]`, nested));
    }
    return `[${pad}${items.join(',' + pad)}${close}]`;
  }

  if (!isPlainObject(value)) throw new CanonicalJsonError(path, 'not a plain object or array');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) return '{}';
  const entries = keys.map((key) => {
    const child = write(record[key], indent, depth + 1, path ? `${path}.${key}` : key, nested);
    return `${JSON.stringify(key)}${colon}${child}`;
  });
  return `{${pad}${entries.join(',' + pad)}${close}}`;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, numbers in their
 * shortest round-trip form. Throws CanonicalJsonError for NaN, +/-Infinity, undefined, -0,
 * bigint, functions, circular references and non-plain objects instead of coercing them.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0, 0, '', []);
}

/** Same ordering and number rules as `canonicalJson`, pretty-printed with `indent` spaces. */
export function canonicalStringify(value: unknown, indent = 2): string {
  return write(value, indent, 0, '', []);
}
