/**
 * TASK-53: the ONE open-surface stack — ESC opens the menu from the empty
 * stack and otherwise POPS the top (panel → menu → closed); the chart never
 * duplicates and never stacks on a panel; one panel per stack; the gate
 * (`anySurfaceOpen`) is true while ANY surface is up (game input is
 * suppressed, the world keeps simulating); emit-on-change + late
 * subscribers catch up (the cargo.ts idiom).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetMenu,
  anySurfaceOpen,
  closeAllSurfaces,
  menuStack,
  menuSubscribe,
  openChart,
  openMenu,
  openPanel,
  popSurface,
  topSurface,
} from './menu';

beforeEach(() => __resetMenu());

describe('menu stack (TASK-53)', () => {
  it('starts empty: no top surface, the input gate is open', () => {
    expect(menuStack()).toHaveLength(0);
    expect(topSurface()).toBeNull();
    expect(anySurfaceOpen()).toBe(false);
  });

  it('ESC from the empty stack opens the menu; ESC pops it back to closed', () => {
    expect(openMenu()).toBe(true);
    expect(topSurface()?.kind).toBe('menu');
    expect(anySurfaceOpen()).toBe(true); // game input now suppressed
    expect(popSurface()?.kind).toBe('menu');
    expect(topSurface()).toBeNull();
    expect(anySurfaceOpen()).toBe(false);
  });

  it('openMenu is refused while a surface is open (ESC pops instead of nesting menus)', () => {
    openMenu();
    expect(openMenu()).toBe(false);
    expect(menuStack()).toHaveLength(1);
    expect(topSurface()?.kind).toBe('menu');
  });

  it('the chart opens from the empty stack AND on top of the menu, never twice', () => {
    expect(openChart()).toBe(true);
    expect(menuStack().map((s) => s.kind)).toEqual(['chart']);
    expect(openChart()).toBe(false); // no duplicate
    expect(menuStack()).toHaveLength(1);
  });

  it('ESC backing out of the chart returns to the menu underneath (one level at a time)', () => {
    openMenu();
    openChart();
    expect(menuStack().map((s) => s.kind)).toEqual(['menu', 'chart']);
    expect(popSurface()?.kind).toBe('chart');
    expect(topSurface()?.kind).toBe('menu');
    expect(popSurface()?.kind).toBe('menu');
    expect(topSurface()).toBeNull();
  });

  it('the chart never stacks on a panel', () => {
    openPanel({ id: 'cargo-panel', title: 'CARGO', context: 'flight', activeTab: 'cargo' });
    expect(openChart()).toBe(false);
    expect(topSurface()?.kind).toBe('panel');
  });

  it('one panel per stack, whichever context opened it (dock replaces nothing)', () => {
    expect(openPanel({ id: 'ship-panel', title: 'SHIP', context: 'docked', activeTab: 'overview' })).toBe(
      true,
    );
    expect(openPanel({ id: 'dock-panel', title: 'STATION DOCK', context: 'dock', activeTab: 'sell' })).toBe(
      false,
    );
    expect((topSurface() as { id?: string }).id).toBe('ship-panel');
  });

  it('popSurface returns the popped surface; null on an empty stack', () => {
    expect(popSurface()).toBeNull();
    openMenu();
    openPanel({ id: 'dock-panel', title: 'STATION DOCK', context: 'dock', activeTab: 'sell' });
    const popped = popSurface();
    expect(popped?.kind).toBe('panel');
    expect(topSurface()?.kind).toBe('menu');
  });

  it('closeAllSurfaces empties the whole stack at once', () => {
    openMenu();
    openChart();
    closeAllSurfaces();
    expect(menuStack()).toHaveLength(0);
    expect(anySurfaceOpen()).toBe(false);
  });

  it('emits only on real changes; late subscribers catch up with the current stack', () => {
    const seen: number[] = [];
    const off = menuSubscribe((s) => seen.push(s.length));
    expect(seen).toEqual([0]); // immediate catch-up
    openMenu();
    openMenu(); // refused → no emit
    expect(seen).toEqual([0, 1]);
    off();
    openChart();
    expect(seen).toEqual([0, 1]); // unsubscribed → no further sees
    const late: number[] = [];
    menuSubscribe((s) => late.push(s.length));
    expect(late).toEqual([2]); // late subscriber sees [menu, chart]
  });
});
