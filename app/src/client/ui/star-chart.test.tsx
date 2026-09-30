import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartMap } from './chart-map';
import { galaxyChart, systemIdForStar } from '@shared/galaxy/chart';
import { generateStars } from '@shared/galaxy/stars';
import { SPECTRAL_COLORS } from './chart-map';

const SEED = 'DRIFT-SEED-0001';
const CHART = galaxyChart(SEED, systemIdForStar(SEED, generateStars(SEED)[2].id));
const [A, B, C] = CHART;

/** Render the pure map with fixed props (no effects, no DOM needed). */
function renderMap(overrides: Partial<Parameters<typeof ChartMap>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChartMap
      systems={CHART}
      occupancy={{}}
      currentSystemId={A.systemId}
      selectedSystemId={null}
      warpingSystemId={null}
      focusedSystemId={null}
      query=""
      {...overrides}
    />,
  );
}

describe('ChartMap rendering (TASK-7)', () => {
  it('renders one node per system, one edge per pair', () => {
    const html = renderMap();
    const nodes = html.match(/data-testid="star-chart-node"/g) ?? [];
    const edges = html.match(/data-testid="star-chart-edge"/g) ?? [];
    expect(nodes).toHaveLength(CHART.length);
    expect(edges).toHaveLength(3); // K3
  });

  it('uses the spectral-class color for each node', () => {
    const html = renderMap();
    for (const s of CHART) {
      expect(html).toContain(`fill="${SPECTRAL_COLORS[s.starClass]}"`);
      expect(html).toContain(s.name);
    }
  });

  it('labels edges with the light-second distance + warp time', () => {
    const html = renderMap();
    for (const s of CHART) {
      for (const n of s.neighbors) {
        expect(html).toContain(`${n.distanceLabel} · ${n.warpTimeLabel}`);
      }
    }
  });

  it('highlights the current system node', () => {
    const html = renderMap();
    expect(html).toContain(`data-system-id="${A.systemId}" data-current="true"`);
    expect(html).not.toContain(`data-system-id="${B.systemId}" data-current="true"`);
  });

  it('marks the selected node (aria-pressed) and only that one', () => {
    const html = renderMap({ selectedSystemId: B.systemId });
    expect(html).toContain(
      `data-system-id="${B.systemId}" data-current="false" data-selected="true"`,
    );
    expect(html).toContain(`data-system-id="${B.systemId}"`);
    expect(html).toContain(`aria-pressed="true"`);
    expect(html).toContain(
      `data-system-id="${A.systemId}" data-current="true" data-selected="false"`,
    );
    expect(html).toContain(
      `data-system-id="${C.systemId}" data-current="false" data-selected="false"`,
    );
  });

  it('renders an occupancy badge with the player count, hidden when 0', () => {
    const html = renderMap({ occupancy: { [A.systemId]: 2, [B.systemId]: 1, [C.systemId]: 0 } });
    const badges = html.match(/data-testid="occupancy-badge"/g) ?? [];
    expect(badges).toHaveLength(2); // C has 0 players → no badge
    const nodeA = html.slice(html.indexOf(`data-system-id="${A.systemId}"`));
    const badgeA = nodeA.slice(0, nodeA.indexOf('</g></g>'));
    expect(badgeA).toContain('2');
  });

  it('renders no badges when all systems are empty', () => {
    const html = renderMap({ occupancy: {} });
    expect(html).not.toContain('occupancy-badge');
  });

  it('shows the Warping state text on the source node only', () => {
    const html = renderMap({ warpingSystemId: A.systemId });
    expect(html).toContain('Warping…');
    // It must sit on A's node group, before B's node starts.
    const nodeA = html.indexOf(`data-system-id="${A.systemId}"`);
    const nodeB = html.indexOf(`data-system-id="${B.systemId}"`);
    const warpAt = html.indexOf('Warping…');
    expect(warpAt).toBeGreaterThan(nodeA);
    expect(warpAt).toBeLessThan(nodeB);
  });

  it('dims nodes that do not match the search query, never removes them', () => {
    const noMatch = renderMap({ query: 'zzz-not-a-system' });
    for (const s of CHART) {
      const at = noMatch.indexOf(`data-system-id="${s.systemId}"`);
      expect(noMatch.slice(at, at + 400)).toContain('opacity="0.25"');
    }
    const someMatch = renderMap({ query: A.name.split(' ')[0] });
    const atA = someMatch.indexOf(`data-system-id="${A.systemId}"`);
    expect(someMatch.slice(atA, atA + 400)).not.toContain('opacity="0.25"');
  });

  it('is a pure function of the seeded chart data (SVG structure snapshot)', () => {
    // Same GALAXY_SEED → same layout, frozen here as the TASK-7 baseline.
    expect(renderMap()).toMatchSnapshot();
    expect(renderMap()).toEqual(renderMap());
  });
});
