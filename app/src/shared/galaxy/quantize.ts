/**
 * Rounds to 3 decimals using only exact operations (multiply, round, divide). The trailing
 * `+ 0` turns a possible -0 into +0 so values stay representable in canonical JSON.
 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}

/** Rounds to 1 decimal; see `round3` for why this is engine-independent. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}
