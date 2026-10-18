/**
 * Travel + warp math shared between the server's `/api/galaxy/overview`
 * endpoint and the client chart UI (TASK-7).
 *
 * This module is pure (no `Math.random`, no `Date.now`) and
 * deterministic given its inputs. The chart layout (projected
 * 2-D coordinates) and the per-edge warp-time table both flow
 * from here so the server and client agree on every number the
 * player sees.
 *
 * ## Units
 *
 * Star coordinates are produced by `generateStars` in **galactic
 * units** (gu; ~ kpc per the type docs). For the chart we project
 * each star's `(x, y)` onto the galactic plane (`z` is the thin-disk
 * thickness and is ignored — the chart is a 2-D top-down view).
 *
 * For warp travel we convert galactic distance into **light-seconds**
 * via `GU_TO_LIGHT_SECONDS` so the chart's "warp time" reads as a
 * number the player can reason about (a 30 s trip is a "short hop";
 * a 10 min trip is a "long voyage"). The conversion is intentionally
 * generous — see `WARP_SPEED_LIGHT_SECONDS_PER_SECOND` — so the
 * values come out to playable durations on the in-game HUD.
 *
 * ## Edge construction
 *
 * We do **not** connect every star to every other (that would be
 * `N²` edges). Instead we connect each star to its `K` nearest
 * neighbours (`NEAREST_NEIGHBOUR_COUNT = 3`) using Euclidean
 * distance on the projected plane. This gives a connected,
 * visually-readable graph where every star has at least 3 edges
 * going to nearby systems — enough to render as a "spider-web" of
 * warp lanes without spamming the UI with `200² / 2` lines.
 *
 * @see ./stars.ts for the upstream generator whose output we wrap.
 * @see ./overview.ts for the public chart payload built on top of
 *      these helpers.
 * @see ../../client/ui/StarChart.tsx for the consumer.
 */

import type { Star } from "./types.js";

// ---------------------------------------------------------------------------
// Unit conversions
// ---------------------------------------------------------------------------

/**
 * One galactic unit in light-seconds. The galactic units from
 * `generateStars` are a dimensionless game scale (~ kpc). Converting
 * 1 gu → 100 light-seconds gives a useful spread of distances:
 *
 *   - Closest neighbours (~1 gu apart) → 100 ls → 10 s warp
 *   - Median distance (~10 gu) → 1000 ls → 100 s warp
 *   - Antipodal pair (~50 gu) → 5000 ls → 500 s warp
 *
 * The numbers are tuned so a typical intra-cluster hop completes in
 * well under a minute and a cross-galaxy voyage is a multi-minute
 * commitment — both produce a noticeable countdown on the chart.
 */
export const GU_TO_LIGHT_SECONDS = 100;

/**
 * Warp speed in light-seconds per real-time second. At 10 ls/s a
 * 100 ls hop takes 10 s; a 5000 ls voyage takes 500 s (~8 min).
 * Tuned so warp times are *visible* on the chart's HUD but still
 * fast enough that a tester can wait one out during smoke tests.
 */
export const WARP_SPEED_LIGHT_SECONDS_PER_SECOND = 10;

/**
 * Number of nearest neighbours each star is connected to. Three
 * edges per node gives a connected, planar-feeling graph; six edges
 * would already be dense for a 200-star galaxy.
 */
export const NEAREST_NEIGHBOUR_COUNT = 3;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/**
 * Euclidean distance between two stars on the galactic plane
 * (z-component ignored). Returns a non-negative number in galactic
 * units.
 */
export function planarDistance(a: Star, b: Star): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Convert a galactic-unit distance to a light-second distance. Pure
 * `n * GU_TO_LIGHT_SECONDS` — kept as a function so the unit
 * conversion is localisable for future tweaks.
 */
export function distanceToLightSeconds(gu: number): number {
  if (!Number.isFinite(gu) || gu < 0) {
    throw new RangeError(
      `distanceToLightSeconds: distance must be a non-negative finite number, got ${gu}`,
    );
  }
  return gu * GU_TO_LIGHT_SECONDS;
}

/**
 * Estimated warp time (seconds) for a given galactic-unit distance.
 * Returns 0 only when the source and destination are identical
 * (zero-distance self-loop is a defensive case — the chart never
 * offers "warp to current system"). Rounded to the nearest second
 * so the HUD label stays readable.
 */
export function warpTimeSeconds(gu: number): number {
  if (!Number.isFinite(gu) || gu < 0) {
    throw new RangeError(
      `warpTimeSeconds: distance must be a non-negative finite number, got ${gu}`,
    );
  }
  const ls = distanceToLightSeconds(gu);
  return Math.round(ls / WARP_SPEED_LIGHT_SECONDS_PER_SECOND);
}

// ---------------------------------------------------------------------------
// Edge construction
// ---------------------------------------------------------------------------

/**
 * One warp-lane edge on the chart.
 *
 * `distanceLs` is the rounded light-second distance between the
 * two stars; `warpTimeSeconds` is the matching warp duration.
 * `warpTimeSeconds` is derived from `distanceLs` (rounded once at
 * the source), so the two fields are always consistent — the chart
 * never shows a "10 s warp over 200 ls" because that would round
 * 100/10=10 to 10, which equals 200/10=20 only when both round to
 * the same integer. The rounding rule keeps both numbers stable
 * across the server and client renders.
 */
export interface NeighborEdge {
  /** Neighbour system id (== neighbour star.id). */
  to: string;
  /** Light-second distance to the neighbour (rounded to nearest integer). */
  distanceLs: number;
  /** Estimated warp travel time in seconds (rounded to nearest integer). */
  warpTimeSeconds: number;
}

/**
 * Compute the neighbour list for every star in the input set.
 *
 * The output list of edges is sorted by `warpTimeSeconds` ascending
 * so the chart can render the *shortest* edge as the primary label
 * (without sorting the chart would have to pick one of multiple
 * edges at render time).
 *
 * **Symmetry:** `computeNeighbors([a, b])` returns an edge from
 * `a → b` **and** an edge from `b → a` with identical
 * `distanceLs`/`warpTimeSeconds`. The chart renders edges
 * undirected, but the data structure is bidirectional so future
 * directional warps (one-way lanes, etc.) can be added by tagging
 * a flag without restructuring the array.
 *
 * Determinism: pure function over `Star[]`. Same input → byte-equal
 * output. No `Math.random` / `Date.now`.
 */
export function computeNeighbors(stars: readonly Star[]): NeighborEdge[] {
  // For every star, sort the other stars by planar distance and
  // take the first `NEAREST_NEIGHBOUR_COUNT`. We do this from the
  // full pairwise matrix to guarantee symmetry (a→b iff b→a) and
  // to keep the algorithm O(N²) — perfectly fine for 200 stars.
  const edges: NeighborEdge[] = [];
  for (let i = 0; i < stars.length; i++) {
    const a = stars[i]!;
    const distances: { idx: number; d: number }[] = [];
    for (let j = 0; j < stars.length; j++) {
      if (j === i) continue;
      const b = stars[j]!;
      distances.push({ idx: j, d: planarDistance(a, b) });
    }
    distances.sort((x, y) => x.d - y.d);
    const top = distances.slice(0, NEAREST_NEIGHBOUR_COUNT);
    for (const { idx, d } of top) {
      const ls = Math.round(distanceToLightSeconds(d));
      edges.push({
        to: stars[idx]!.id,
        distanceLs: ls,
        warpTimeSeconds: Math.round(ls / WARP_SPEED_LIGHT_SECONDS_PER_SECOND),
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// 2-D projection (for the chart viewport)
// ---------------------------------------------------------------------------

/**
 * The viewBox used by the chart. Picked to match the spec's "800x500
 * viewBox" — wider than tall so the disk shape reads as a thin
 * ellipse rather than a circle.
 */
export const STAR_CHART_VIEW_WIDTH = 800;
export const STAR_CHART_VIEW_HEIGHT = 500;

/** A 2-D point in chart viewport coordinates. */
export interface ChartPoint {
  x: number;
  y: number;
}

/**
 * Project a star's `(x, y, z)` galactic coordinates onto the chart
 * viewport. The projection is a simple linear map:
 *
 *   - Find the bounding box of the input stars so the chart
 *     auto-scales (a galaxy with tighter disk radius doesn't leave
 *     70% of the canvas empty).
 *   - Translate so the bounding-box centre lands on the canvas
 *     centre.
 *   - Flip Y so "north" on the chart matches "up" in galactic
 *     coordinates (canvas Y grows downward).
 *   - Pad inside the canvas so star markers don't touch the edge.
 *
 * Pure function. Same input → same output.
 */
export function projectToChart(stars: readonly Star[]): ChartPoint[] {
  if (stars.length === 0) return [];

  // Bounding box across the planar coordinates.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of stars) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);

  // Inner padding so star markers + edge labels don't touch the edge.
  // 5 % on each side.
  const padX = STAR_CHART_VIEW_WIDTH * 0.05;
  const padY = STAR_CHART_VIEW_HEIGHT * 0.05;
  const drawW = STAR_CHART_VIEW_WIDTH - 2 * padX;
  const drawH = STAR_CHART_VIEW_HEIGHT - 2 * padY;

  const scale = Math.min(drawW / width, drawH / height);

  return stars.map((s) => ({
    x: padX + (s.x - cx) * scale + drawW / 2,
    // Flip Y so up on the chart corresponds to +Y in galactic coordinates.
    y: STAR_CHART_VIEW_HEIGHT - (padY + (s.y - cy) * scale + drawH / 2),
  }));
}
