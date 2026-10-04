// @vitest-environment happy-dom
/**
 * TASK-52: HUD mode switch tests — the hard rule that exactly ONE HUD
 * subtree renders: in ship mode NO on-foot element renders (not the weight
 * bar, not the exposure meter, not the interaction line) and in on-foot
 * mode NO ship element renders (not the flight block, not the cargo
 * button) — even when BOTH modes' stores hold data at the same time
 * (the stale-data case: the switch, not the data, decides). A live
 * render-remount simulates the regime-change frame (the switch is one
 * render — atomic with the camera handoff, same event in main.tsx).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetHazards, setHazardFrame } from '@client/state/hazards';
import { __resetInventory, setInventory } from '@client/state/inventory';
import { __resetMining } from '@client/state/mining';
import { __resetShipHud, setSelfShipView } from '@client/state/ship-hud';
import { quatIdentity } from '@shared/physics/vec';
import type { Regime } from '@shared/regime';

import { HudRoot, type HudRootProps } from './hud-root';

let container: HTMLDivElement;
let root: Root;

const base: Omit<HudRootProps, 'mode'> = {
  promptText: null,
  viewport: { w: 1280, h: 720 },
  navSample: () => null,
  dockTarget: () => null,
  stationName: () => null,
  onCargoOpen: () => {},
};

/** Both modes' stores hold data at once (the stale-data case). */
function seedBothModes(): void {
  setSelfShipView({
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 10, y: 0, z: 0 },
    rot: quatIdentity(),
    hull: 1,
    shields: 1,
    regime: 'space' satisfies Regime,
    padId: null,
    atMs: Date.now(),
  });
  setInventory({ stacks: { iron: 12 }, weightUsed: 12 });
  setHazardFrame({ exposure: 30, inside: 'radzone' });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  seedBothModes();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetShipHud();
  __resetInventory();
  __resetHazards();
  __resetMining();
});

function renderMode(mode: HudRootProps['mode']): void {
  act(() => root.render(<HudRoot {...base} promptText={'[E] Enter ship'} mode={mode} />));
}

describe('HudRoot mode switch (TASK-52)', () => {
  it('ship mode: the flight HUD renders and NO on-foot element renders', () => {
    renderMode('ship');
    expect(container.innerHTML).toContain('id="ship-hud-block"');
    expect(container.innerHTML).toContain('id="ship-hud-cargo"');
    // The on-foot elements are GONE even though both stores hold data.
    expect(container.innerHTML).not.toContain('id="weight-bar"');
    expect(container.innerHTML).not.toContain('id="hazard-hud"');
    expect(container.innerHTML).not.toContain('id="interact-prompt"');
  });

  it('on-foot mode: the on-foot elements render and NO ship element renders', () => {
    renderMode('onfoot');
    expect(container.innerHTML).toContain('id="weight-bar"');
    expect(container.innerHTML).toContain('id="hazard-hud"'); // rad zone data is up
    expect(container.innerHTML).toContain('id="interact-prompt"');
    expect(container.innerHTML).toContain('[E] Enter ship');
    // The ship elements are GONE even though the ship store holds data.
    expect(container.innerHTML).not.toContain('id="ship-hud-block"');
    expect(container.innerHTML).not.toContain('id="ship-hud-cargo"');
  });

  it('the switch is atomic: the other mode renders nothing after the switch', () => {
    renderMode('ship');
    expect(container.innerHTML).toContain('id="ship-hud-block"');
    // The regime-change frame: the self entity flips to the character.
    renderMode('onfoot');
    expect(container.innerHTML).not.toContain('id="ship-hud-block"');
    expect(container.innerHTML).not.toContain('id="ship-hud-cargo"');
    expect(container.innerHTML).toContain('id="weight-bar"');
    // And back.
    renderMode('ship');
    expect(container.innerHTML).not.toContain('id="weight-bar"');
    expect(container.innerHTML).not.toContain('id="hazard-hud"');
    expect(container.innerHTML).toContain('id="ship-hud-block"');
  });

  it('no self entity (boot / system swap): nothing renders', () => {
    renderMode(null);
    expect(container.innerHTML).toBe('');
  });
});
