// @vitest-environment happy-dom
/**
 * TASK-51: ship-HUD component tests — live rendering (createRoot + act,
 * happy-dom) so the 10 Hz store subscriptions run: speed/altitude
 * formatting (space shows '—', atmosphere shows meters), regime tag
 * switching, the docked state (green DOCKED tag + station name), the nav
 * readout (bearing arrow + distance; chart target priority), the vitals
 * bar (percentages + 300 ms hit flash on fake timers), and the layout
 * disjointness of the ship-HUD slots against the protected screen regions.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SelfShipView } from '@client/state/ship-hud';
import { __resetShipHud, flashHullHit, setSelfShipView } from '@client/state/ship-hud';
import { __resetChartTarget, setChartTarget } from '@client/state/chart-target';
import { __resetCruiseState, setCruiseState } from '@client/state/cruise';

import { allPairwiseDisjoint, protectedRects, type Viewport } from '../combat-hud/layout';
import { shipHudRects } from './layout';
import { ShipHud } from './ship-hud';

const VP: Viewport = { w: 1_280, h: 720 };

let roots: Root[] = [];

/** The live nav sample is the ship at the ORIGIN (nose +Z) — the dock
 * target sits exactly 12.4 km to the world +X (screen-left of the nose). */
const ORIGIN_POS = { x: 0, y: 0, z: 0 };
const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };

function renderHud(view: SelfShipView | null): HTMLDivElement {
  if (view) setSelfShipView(view);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ShipHud
        viewport={VP}
        navSample={() => (view ? { pos: ORIGIN_POS, rot: IDENTITY_ROT } : null)}
        dockTarget={() =>
          view ? { name: 'TOROLM STATION', pos: { x: 12_400, y: 0, z: 0 } } : null
        }
        stationName={() => 'TOROLM STATION'}
      />,
    );
  });
  roots.push(root);
  return container;
}

/** Let the rAF-driven per-frame work (the chevron transform) run. */
const rafTick = (ms = 50): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

beforeEach(() => {
  __resetShipHud();
  __resetChartTarget();
  __resetCruiseState();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

const mkView = (over: Partial<SelfShipView> = {}): SelfShipView => ({
  pos: { x: 0, y: 1234, z: 0 },
  vel: { x: 3, y: 4, z: 0 },
  rot: { x: 0, y: 0, z: 0, w: 1 },
  hull: 0.75,
  shields: 1,
  regime: 'atmosphere',
  padId: null,
  atMs: 1_000,
  ...over,
});

describe('ShipHud readouts', () => {
  it('is unmounted while the player is on foot (no self-ship view)', () => {
    const el = renderHud(null);
    expect(el.querySelector('#ship-hud-block')).toBeNull();
    expect(el.querySelector('#ship-hud-vitals')).toBeNull();
  });

  it('shows speed (1 decimal) and the regime-aware altitude + tag (ATMOS)', () => {
    const el = renderHud(mkView());
    expect(el.querySelector('#ship-hud-speed')?.textContent).toContain('5.0 m/s');
    expect(el.querySelector('#ship-hud-altitude')?.textContent).toBe('ALT 1234 m');
    expect(el.querySelector('#ship-hud-regime')?.textContent).toBe('ATMOS');
  });

  it('shows "—" altitude and the SPACE tag in space', () => {
    const el = renderHud(mkView({ regime: 'space', pos: { x: 0, y: 9000, z: 0 } }));
    expect(el.querySelector('#ship-hud-altitude')?.textContent).toBe('—');
    expect(el.querySelector('#ship-hud-regime')?.textContent).toBe('SPACE');
  });

  it('shows the SURFACE tag + the green DOCKED tag with the station name on a pad', () => {
    const el = renderHud(mkView({ regime: 'surface', pos: { x: 0, y: 2, z: 0 }, padId: 'pad1' }));
    expect(el.querySelector('#ship-hud-regime')?.textContent).toBe('SURFACE');
    const docked = el.querySelector('#ship-hud-docked');
    expect(docked?.textContent).toContain('DOCKED');
    expect(docked?.textContent).toContain('TOROLM STATION');
    expect(String(docked?.getAttribute('role'))).toBe('status');
  });

  it('hides the docked tag when not on a pad', () => {
    const el = renderHud(mkView());
    expect(el.querySelector('#ship-hud-docked')).toBeNull();
  });
});

describe('ShipHud cruise tag (TASK-85)', () => {
  it('is hidden while boost is not held', () => {
    const el = renderHud(mkView({ regime: 'space' }));
    expect(el.querySelector('#ship-hud-cruise')).toBeNull();
  });

  it('shows CRUISE (bright) while boost is held AND allowed', () => {
    act(() => setCruiseState({ held: true, allowed: true }));
    const el = renderHud(mkView({ regime: 'space' }));
    const tag = el.querySelector('#ship-hud-cruise') as HTMLElement | null;
    expect(tag?.textContent).toBe('CRUISE');
    expect(String(tag?.style.color).toLowerCase()).toBe('#67e8f9'); // bright cyan
  });

  it('shows dimmed CRUISE BLOCKED while held but not allowed (near a planet)', () => {
    act(() => setCruiseState({ held: true, allowed: false }));
    const el = renderHud(mkView({ regime: 'space' }));
    const tag = el.querySelector('#ship-hud-cruise') as HTMLElement | null;
    expect(tag?.textContent).toBe('CRUISE BLOCKED');
    const opacity = Number(tag?.style.opacity);
    expect(opacity).toBeLessThan(1); // dimmed
  });

  it('live-updates when the clearance state changes (subscribe runs)', () => {
    const el = renderHud(mkView({ regime: 'space' }));
    act(() => setCruiseState({ held: true, allowed: true }));
    act(() => setCruiseState({ held: true, allowed: false }));
    expect(el.querySelector('#ship-hud-cruise')?.textContent).toBe('CRUISE BLOCKED');
  });
});

describe('ShipHud nav readout', () => {
  it('points at the implicit dock target with a formatted distance', async () => {
    const el = renderHud(mkView());
    const nav = el.querySelector('#ship-hud-nav');
    expect(nav, 'nav readout rendered').not.toBeNull();
    expect(nav?.textContent).toContain('12.4 km');
    // The chevron rotates per frame (rAF ref'd transform, no React work).
    await rafTick();
    const arrow = el.querySelector('#ship-hud-nav .nav-arrow') as HTMLElement | null;
    expect(arrow, 'chevron rendered').not.toBeNull();
    // Target at world +X, nose +Z → screen-left (−90°).
    expect(arrow?.style.transform).toContain('rotate(-90deg)');
  });

  it('prefers the chart selection (interstellar: name + WARP, no bearing)', () => {
    const el = renderHud(mkView());
    act(() => {
      setChartTarget({ systemId: 's2', name: 'VERNA' });
    });
    const nav = el.querySelector('#ship-hud-nav');
    expect(nav?.textContent).toContain('VERNA');
    expect(nav?.textContent).toContain('WARP');
    act(() => {
      setChartTarget(null);
    });
    expect(el.querySelector('#ship-hud-nav')?.textContent).toContain('12.4 km');
  });
});

describe('ShipHud vitals bar', () => {
  it('shows the hull (amber) and shield (blue) percentages', () => {
    const el = renderHud(mkView({ hull: 0.75, shields: 0.4 }));
    const vitals = el.querySelector('#ship-hud-vitals');
    expect(vitals, 'vitals bar rendered').not.toBeNull();
    expect(vitals?.textContent).toContain('75%');
    expect(vitals?.textContent).toContain('40%');
  });

  it('flashes red for the 300 ms window after a self hit', async () => {
    const el = renderHud(mkView());
    const vitals = el.querySelector('#ship-hud-vitals') as HTMLElement;
    expect(vitals.getAttribute('data-hit')).toBe('0');

    act(() => {
      flashHullHit();
    });
    // The red flash is the 300 ms CSS class toggle (data-hit drives it).
    expect(vitals.getAttribute('data-hit')).toBe('1');

    await rafTick(100);
    expect(vitals.getAttribute('data-hit')).toBe('1'); // still inside the window

    // Past the 300 ms window: the class toggle has cleared.
    await rafTick(300);
    expect(vitals.getAttribute('data-hit')).toBe('0');
  });
});

describe('ShipHud layout disjointness (1280×720 reference viewport)', () => {
  it('never overlaps the protected regions (chat, player list, prompt, debug)', () => {
    expect(allPairwiseDisjoint({ ...shipHudRects(VP), ...protectedRects(VP) })).toBe(true);
  });
});
