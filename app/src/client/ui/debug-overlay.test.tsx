import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DebugOverlay,
  OVERLAY_POLL_MS,
  statsExportPayload,
  surfaceTrisLine,
} from './debug-overlay';
import type { FrameStats } from '@client/perf/frameMonitor';

/** A fixed mock snapshot of the monitor, decoupled from the live instance. */
const MOCK_STATS: FrameStats = {
  fps: 59,
  frameTimeP50Ms: 16.21,
  frameTimeP95Ms: 22.35,
  frameTimeP99Ms: 31.02,
  maxFrameMs: 31.02,
  drawCalls: 12,
  triangles: 84_210,
  entities: 7,
  categoryTriangles: {},
};

describe('DebugOverlay rendering (TASK-57)', () => {
  it('shows every stat from the mocked monitor', () => {
    const html = renderToStaticMarkup(<DebugOverlay stats={MOCK_STATS} />);
    expect(html).toContain('id="frame-monitor"');
    expect(html).toContain('FRAME MONITOR (F3)');
    expect(html).toContain('FPS ');
    expect(html).toContain('>59<'); // fps value
    expect(html).toContain('16.21 / 22.35 / 31.02 ms'); // p50/p95/p99
    expect(html).toContain('>12<'); // draw calls
    expect(html).toContain('>84210<'); // triangles
    expect(html).toContain('ENTITIES');
    expect(html).toContain('>7<'); // entity count
  });

  it('renders an export button only when the host wires one', () => {
    const bare = renderToStaticMarkup(<DebugOverlay stats={MOCK_STATS} />);
    expect(bare).not.toContain('id="frame-monitor-export"');
    const wired = renderToStaticMarkup(<DebugOverlay stats={MOCK_STATS} onExport={() => {}} />);
    expect(wired).toContain('id="frame-monitor-export"');
    expect(wired).toContain('EXPORT STATS');
  });

  it('polls at 2 Hz (500 ms cadence per spec)', () => {
    expect(OVERLAY_POLL_MS).toBe(500);
  });

  it('exports a flat, timestamped payload', () => {
    const payload = statsExportPayload(MOCK_STATS, '2026-09-30T00:00:00.000Z');
    expect(payload).toMatchObject({ ...MOCK_STATS, exportedAt: '2026-09-30T00:00:00.000Z' });
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

describe('DebugOverlay surface-tris line (TASK-26)', () => {
  it('shows the SURFACE line with per-ring counts when categories are reported', () => {
    const html = renderToStaticMarkup(
      <DebugOverlay
        stats={{
          ...MOCK_STATS,
          categoryTriangles: { 'surface-near': 81_920, 'surface-mid': 8_192, 'surface-far': 26 },
        }}
      />,
    );
    expect(html).toContain('SURFACE tris 90138 (near 81920 · mid 8192 · far 26)');
    // The line sits between the TRIS and the ENTITIES row.
    expect(html.indexOf('SURFACE tris')).toBeGreaterThan(html.indexOf('TRIS'));
    expect(html.indexOf('SURFACE tris')).toBeLessThan(html.indexOf('ENTITIES'));
  });

  it('omits the SURFACE line when no surface category has been reported', () => {
    const html = renderToStaticMarkup(<DebugOverlay stats={MOCK_STATS} />);
    expect(html).not.toContain('SURFACE tris');
  });

  it('treats unreported rings as zero', () => {
    expect(surfaceTrisLine({ 'surface-far': 10 })).toBe(
      'SURFACE tris 10 (near 0 · mid 0 · far 10)',
    );
    expect(surfaceTrisLine({})).toBeNull();
  });
});
