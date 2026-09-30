/**
 * Star chart layout + travel table (TASK-7).
 *
 * Pure and deterministic: galaxyChart(seed, homeSystemId) returns the exact
 * same ChartSystem[] for the same arguments, in Node and in the browser.
 *
 * v1 scope: the chart shows CHART_SYSTEM_COUNT (3) seeded systems — the
 * player's current system plus its two nearest neighbours in the full seeded
 * galaxy. The full K3 edge set is labeled with the light-second distance and
 * the warp time from the travel table below, so the numbers are identical on
 * every client and every server (same GALAXY_SEED).
 */

import { seedFromString, hash2 } from '../random.js';
import { GALAXY_STAR_COUNT } from './config.js';
import { generateStars } from './stars.js';
import type { SpectralClass, Star } from './types.js';

/** v1 chart size: the current system + its 2 nearest seeded neighbours. */
export const CHART_SYSTEM_COUNT = 3;

/** Chart SVG canvas (TASK-7 spec: 800x500 viewBox). */
export const CHART_VIEWBOX = { width: 800, height: 500, margin: 60 } as const;

/** Travel table (TASK-7): 1 galactic unit = 60 000 light-seconds. */
export const GALACTIC_UNIT_LIGHT_SECONDS = 60_000;

/** Travel table (TASK-7): warp drive speed in light-seconds per second. */
export const WARP_SPEED_LS_PER_S = 100_000;

/** A directed edge from one chart system to a neighbour. */
export interface ChartNeighbor {
  /** Target system id (16-hex). */
  to: string;
  /** Separation in galactic units (3D euclidean). */
  distanceGu: number;
  /** Human-readable light-second distance for the edge label. */
  distanceLabel: string;
  /** Estimated warp duration, seconds (ceil, min 1). */
  warpTimeSeconds: number;
  /** Human-readable warp time for the edge label. */
  warpTimeLabel: string;
}

/** One node of the star chart. */
export interface ChartSystem {
  /** System id (16-hex, same scheme as generateSystem). */
  systemId: string;
  /** Host star id (16-hex). */
  starId: string;
  /** Star name (unique in the galaxy). */
  name: string;
  /** Star spectral class — drives the node color. */
  starClass: SpectralClass;
  /** Deterministic 2D projection into the CHART_VIEWBOX (galactic plane). */
  pos2D: { x: number; y: number };
  /** Every other chart system, in ascending distance order. */
  neighbors: ChartNeighbor[];
}

/** Same (seed, starId) sub-seed scheme as generateSystem → stable ids. */
export function systemIdForStar(seed: string, starId: string): string {
  return hash2(seedFromString(seed), seedFromString(starId)).toString(16).padStart(16, '0');
}

/**
 * Travel table: estimated warp duration for a galactic-unit distance.
 * Ceil to whole seconds, minimum 1 s (neighbours are never free).
 */
export function warpTimeSeconds(distanceGu: number): number {
  return Math.max(1, Math.ceil((distanceGu * GALACTIC_UNIT_LIGHT_SECONDS) / WARP_SPEED_LS_PER_S));
}

/** Compact light-second label: "500 ls", "2.5k ls", "3.2M ls", "1.4B ls". */
export function formatLightSeconds(ls: number): string {
  if (ls >= 1e9) return `${(ls / 1e9).toFixed(1)}B ls`;
  if (ls >= 1e6) return `${(ls / 1e6).toFixed(1)}M ls`;
  if (ls >= 1e3) return `${(ls / 1e3).toFixed(1)}k ls`;
  return `${Math.round(ls)} ls`;
}

/** Compact warp-time label: "45s", "2m 5s", "1h 2m". */
export function formatWarpTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function starDistance(a: Star, b: Star): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Derive the v1 star chart from the seeded galaxy.
 *
 * - Finds the star hosting `homeSystemId` (same sub-seed scheme as
 *   generateSystem, so no geometry is ever stored); unknown ids fall back to
 *   star index 0 so the endpoint never errors on a stale system id.
 * - Picks the two nearest other stars (ties broken by star index).
 * - Projects (x, y) onto the galactic plane and fits the bounding box into
 *   the CHART_VIEWBOX, leaving the margin for labels.
 */
export function galaxyChart(
  seed: string,
  homeSystemId: string,
  starCount: number = GALAXY_STAR_COUNT,
): ChartSystem[] {
  const stars = generateStars(seed, starCount);
  const sysIdOf = (star: Star): string => systemIdForStar(seed, star.id);

  let homeIndex = 0;
  for (let i = 0; i < stars.length; i++) {
    if (sysIdOf(stars[i]) === homeSystemId) {
      homeIndex = i;
      break;
    }
  }

  const home = stars[homeIndex];
  const nearest = stars
    .map((s, i) => ({ star: s, index: i, d: starDistance(home, s) }))
    .filter((o) => o.index !== homeIndex)
    .sort((a, b) => a.d - b.d || a.index - b.index);
  const picked = [home, nearest[0].star, nearest[1].star];

  // Deterministic 2D projection: fit the picked stars' bounding box into
  // the viewbox (galactic plane = x/y; the thin z stays in the distance).
  const xs = picked.map((s) => s.x);
  const ys = picked.map((s) => s.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const dx = Math.max(...xs) - minX || 1;
  const dy = Math.max(...ys) - minY || 1;
  const innerW = CHART_VIEWBOX.width - 2 * CHART_VIEWBOX.margin;
  const innerH = CHART_VIEWBOX.height - 2 * CHART_VIEWBOX.margin;
  const scale = Math.min(innerW / dx, innerH / dy);
  const offX = CHART_VIEWBOX.margin + (innerW - dx * scale) / 2;
  const offY = CHART_VIEWBOX.margin + (innerH - dy * scale) / 2;

  return picked.map((star) => {
    const neighbors = picked
      .filter((other) => other.id !== star.id)
      .map((other) => {
        const distanceGu = starDistance(star, other);
        const distanceLabel = formatLightSeconds(distanceGu * GALACTIC_UNIT_LIGHT_SECONDS);
        const eta = warpTimeSeconds(distanceGu);
        return {
          to: sysIdOf(other),
          distanceGu,
          distanceLabel,
          warpTimeSeconds: eta,
          warpTimeLabel: formatWarpTime(eta),
        };
      })
      .sort((a, b) => a.distanceGu - b.distanceGu);
    return {
      systemId: sysIdOf(star),
      starId: star.id,
      name: star.name,
      starClass: star.class,
      pos2D: {
        x: round2((star.x - minX) * scale + offX),
        y: round2((star.y - minY) * scale + offY),
      },
      neighbors,
    };
  });
}
