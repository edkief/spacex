import { GALAXY_SEED } from '../app';
import { generateStars } from '../../shared/galaxy/stars';
import { projectAndScale, computeGalaxyEdges, SystemChartNode } from '../../shared/galaxy/travel';

/**
 * Cached overview of the galaxy for the star chart.
 * Generated once from the seed and reused.
 */
let cachedOverview: SystemChartNode[] | null = null;

export function getGalaxyOverview(): SystemChartNode[] {
  if (cachedOverview) {
    return cachedOverview;
  }

  const stars = generateStars(GALAXY_SEED);
  const positions = projectAndScale(stars, 800, 500);
  const edges = computeGalaxyEdges(stars);

  cachedOverview = stars.map((star) => ({
    systemId: star.id,
    name: star.name,
    starClass: star.class,
    pos2D: positions[star.id],
    neighbors: edges[star.id],
  }));

  return cachedOverview;
}
