/**
 * Galaxy overview — the payload that drives the star chart UI (TASK-7).
 *
 * Combines the deterministic star list, the per-star system bodies,
 * and the warp-edge table into a single shape the chart renders
 * directly. Built once per server boot (the galaxy seed never
 * changes at runtime) and served from a tiny in-process cache so
 * `/api/galaxy/overview` stays cheap to poll.
 *
 * ## Determinism contract
 *
 * `buildGalaxyOverview(seed, starCount, currentSystemId)` is a pure
 * function over `(seed, starCount, currentSystemId)`:
 *
 *   - `seed` and `starCount` come from server config (constant for
 *     the process lifetime).
 *   - `currentSystemId` is per-request and only affects the
 *     `currentSystemId` field on the response (which star is
 *     highlighted in the chart). The graph layout is independent.
 *
 * Two requests with the same inputs produce byte-equal output. The
 * server caches the response keyed on `(seed, starCount)`; the
 * `currentSystemId` is filled in per request.
 *
 * @see ./travel.ts for the warp-time + projection helpers.
 * @see ./stars.ts for the upstream generator.
 * @see ./system.ts for the per-star planet list.
 * @see ../../server/routes/galaxy-overview.ts for the endpoint that
 *      exposes this to the client.
 */

import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import type { SpectralClass, Star, SystemGen } from "./types.js";
import {
  STAR_CHART_VIEW_HEIGHT,
  STAR_CHART_VIEW_WIDTH,
  computeNeighbors,
  projectToChart,
  type NeighborEdge,
} from "./travel.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One star on the chart. Combines:
 *   - star identity (`systemId` === `id`)
 *   - display info (`name`, `starClass`)
 *   - chart coordinates (`pos2D` — viewport-space, not galactic)
 *   - warp edges (`neighbors`)
 *
 * The `pos2D` is derived from the full galaxy projection so the
 * chart positions are stable even when only one star's system body
 * changes (TASK-71 determinism requirement: same seed → same
 * layout).
 */
export interface OverviewSystemNode {
  /** Stable system id (== `Star.id`). */
  systemId: string;
  /** Display name (e.g. "Ilmamnya system"). */
  name: string;
  /** Spectral class for the chart marker colour. */
  starClass: SpectralClass;
  /** Chart viewport coordinates (x, y in pixels, top-left origin). */
  pos2D: { x: number; y: number };
  /** Nearest-neighbour warp edges (sorted by warp time ascending). */
  neighbors: NeighborEdge[];
}

/**
 * The full chart payload.
 *
 * `systems` is the iterable the chart renders. `viewBox` is the
 * chart canvas dimensions so the client doesn't need to duplicate
 * the projection math to size its SVG. `currentSystemId` is the
 * local player's current system — the chart uses it to highlight
 * the "you are here" node and to disable the Warp button when the
 * selected target === current.
 */
export interface GalaxyOverview {
  /** Source galaxy seed (echoed for the client to display in the header). */
  galaxySeed: string;
  /** Width of the chart viewport (matches `STAR_CHART_VIEW_WIDTH`). */
  viewBoxWidth: number;
  /** Height of the chart viewport. */
  viewBoxHeight: number;
  /** All systems on the chart, in deterministic star order. */
  systems: OverviewSystemNode[];
  /** Player's current system id (or `null` if pre-handshake). */
  currentSystemId: string | null;
}

// ---------------------------------------------------------------------------
// Per-system body cache
// ---------------------------------------------------------------------------

/**
 * Cache the per-star system body (planet list) keyed on star id so
 * a 200-star galaxy only invokes `generateSystemFromStar` once per
 * star per process lifetime. The cache is a `Map` for O(1) lookup;
 * the value is the full `SystemGen` because the chart UI (and any
 * future "click a star to see its planets" panel) only needs a
 * subset and the overhead is negligible at 200 stars.
 */
function buildSystemCache(stars: readonly Star[], seed: string): Map<string, SystemGen> {
  const cache = new Map<string, SystemGen>();
  for (const star of stars) {
    cache.set(star.id, generateSystemFromStar(seed, star));
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the chart payload from a seed + optional current-system
 * hint. Pure function: same inputs → same output.
 *
 * The `currentSystemId` is just a UI hint — it does NOT affect the
 * layout. The chart highlights whichever node has the matching
 * `systemId`. Pass `null` (or omit) when the local player hasn't
 * joined a system yet.
 */
export function buildGalaxyOverview(
  seed: string,
  starCount: number,
  currentSystemId: string | null = null,
): GalaxyOverview {
  const stars = generateStars(seed, starCount);
  const positions = projectToChart(stars);
  const systemCache = buildSystemCache(stars, seed);

  // Pre-compute the neighbour list ONCE per star (the warp time
  // table is shared by both directions of the undirected edge).
  const neighborByStar = new Map<string, NeighborEdge[]>();
  for (const star of stars) {
    neighborByStar.set(star.id, computeNeighbors([star, ...stars.filter((s) => s.id !== star.id)]));
  }

  const nodes: OverviewSystemNode[] = stars.map((star, i) => {
    const sys = systemCache.get(star.id)!;
    const pos = positions[i]!;
    return {
      systemId: star.id,
      name: sys.name,
      starClass: star.class,
      pos2D: { x: roundPos(pos.x), y: roundPos(pos.y) },
      neighbors: neighborByStar.get(star.id)!,
    };
  });

  return {
    galaxySeed: seed,
    viewBoxWidth: STAR_CHART_VIEW_WIDTH,
    viewBoxHeight: STAR_CHART_VIEW_HEIGHT,
    systems: nodes,
    currentSystemId,
  };
}

/**
 * Round a chart coordinate to 3 decimal places. The chart math
 * runs at full float precision but the JSON payload is logged +
 * snapshot-tested; rounding here prevents accidental `Math.exp`
 * platform drift from producing a different byte string between
 * Node and the browser. 3 decimals ≈ 1/1000 of a pixel at the
 * default viewport, well below any visible jitter.
 */
function roundPos(n: number): number {
  return Math.round(n * 1000) / 1000;
}
