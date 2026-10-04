// @vitest-environment happy-dom
/**
 * TASK-54: reduced motion — the warp overlay is a SIMPLE FADE veil
 * (no spinning streak, no core, no canvas shake class) while the phase
 * choreography still runs; flag off restores the streak FX.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetWarpPhase, setWarpPhase } from '@client/state/warp';
import { SETTING_KEYS } from '@shared/settings';
import { __resetSettings, setSetting } from '@client/a11y/reduced-motion';
import { WarpOverlay } from './warp-overlay';

let roots: Root[] = [];

function renderWithEffects(el: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  act(() => r.render(el));
  roots.push(r);
  return container;
}

beforeEach(() => {
  __resetWarpPhase();
  __resetSettings();
  // The overlay renders while a warp is in flight (the 2 s warp-in half).
  setWarpPhase('warping-in');
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  __resetWarpPhase();
  __resetSettings();
});

describe('WarpOverlay reduced motion (TASK-54)', () => {
  it('renders the streak FX by default (and shakes the canvas during warp-in)', () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    document.body.appendChild(canvas);
    const html = renderWithEffects(<WarpOverlay />).innerHTML;
    expect(html).toContain('class="warp-streaks"');
    expect(html).toContain('class="warp-core"');
    expect(html).not.toContain('data-reduced-motion="true"');
    expect(canvas.className).toContain('warp-shake');
  });

  it('reduced motion: a simple fade veil — no streak, no core, no shake', () => {
    setSetting(SETTING_KEYS.reducedMotion, true);
    const canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    document.body.appendChild(canvas);
    const html = renderWithEffects(<WarpOverlay />).innerHTML;
    expect(html).toContain('id="warp-overlay"');
    expect(html).toContain('data-reduced-motion="true"');
    // (the <style> tag always carries the FX selectors — assert the DOM
    // elements, not the stylesheet text)
    expect(html).not.toContain('class="warp-streaks"');
    expect(html).not.toContain('class="warp-core"');
    expect(canvas.className).not.toContain('warp-shake');
  });

  it('takes effect immediately: flipping the flag mid-warp swaps the veil', () => {
    const el = renderWithEffects(<WarpOverlay />);
    expect(el.innerHTML).toContain('class="warp-streaks"');
    act(() => setSetting(SETTING_KEYS.reducedMotion, true));
    expect(el.innerHTML).toContain('data-reduced-motion="true"');
    expect(el.innerHTML).not.toContain('class="warp-streaks"');
  });
});
