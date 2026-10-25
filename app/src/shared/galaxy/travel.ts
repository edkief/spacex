import { Star } from './types';

export const WARP_SPEED_LS_PER_SEC = 1000;

export interface WarpEdge {
  to: string;
  distance: number;
  warpTime: number;
}

export interface SystemChartNode {
  systemId: string;
  name: string;
  starClass: string;
  pos2D: { x: number; y: number };
  neighbors: WarpEdge[];
}

/**
 * Computes Euclidean distance between two stars.
 */
export function getDistance(a: Star, b: Star): number {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
}

/**
 * Computes estimated warp time based on distance.
 */
export function getWarpTime(distance: number): number {
  return Math.ceil(distance / WARP_SPEED_LS_PER_SEC);
}

/**
 * Projects 3D coordinates to a 2D plane and scales to a given viewBox.
 */
export function projectAndScale(
  stars: Star[],
  width: number,
  height: number,
): Record<string, { x: number; y: number }> {
  if (stars.length === 0) return {};

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const s of stars) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const padding = 40;

  const result: Record<string, { x: number; y: number }> = {};
  for (const s of stars) {
    result[s.id] = {
      x: padding + ((s.x - minX) / rangeX) * (width - 2 * padding),
      y: padding + ((s.y - minY) / rangeY) * (height - 2 * padding),
    };
  }

  return result;
}

/**
 * Finds the 3 nearest neighbors for each star.
 */
export function computeGalaxyEdges(stars: Star[]): Record<string, WarpEdge[]> {
  const edges: Record<string, WarpEdge[]> = {};

  for (const s1 of stars) {
    const distances = stars
      .filter((s2) => s1.id !== s2.id)
      .map((s2) => ({
        to: s2.id,
        distance: getDistance(s1, s2),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map((edge) => ({
        ...edge,
        warpTime: getWarpTime(edge.distance),
      }));

    edges[s1.id] = distances;
  }

  return edges;
}
