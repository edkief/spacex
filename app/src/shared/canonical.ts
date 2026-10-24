/**
 * Recursively sorts object keys to ensure deterministic JSON stringification.
 * Arrays are preserved in their original order.
 * 
 * @param value The value to canonicalize.
 * @returns A new value with sorted keys for all nested objects.
 */
export function canonicalize(value: any): any {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc: any, key: string) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Produces a stable JSON string representation of the given value.
 * 
 * @param value The value to stringify.
 * @param indent Indentation level for pretty-printing. Defaults to 2.
 * @returns A deterministic JSON string.
 */
export function canonicalJson(value: any, indent: number = 2): string {
  return JSON.stringify(canonicalize(value), null, indent);
}
