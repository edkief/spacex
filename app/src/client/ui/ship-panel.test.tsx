// @vitest-environment happy-dom
/**
 * TASK-53: the ONE shared ship/dock panel — the context-driven tab set
 * (docked: OVERVIEW/CARGO/REPAIR, flight: OVERVIEW/CARGO, dock:
 * OVERVIEW/CARGO/SELL), tab switching (click + ArrowLeft/ArrowRight with
 * focus follow), the docked-gated Repair tab (cost preview + the reason
 * line when undocked), and the livery picker's 500 ms save debounce
 * (5 rapid changes → exactly ONE onLivery request — the panel's only
 * network-touching control).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Livery } from '@shared/ships';
import { __resetMenu, openPanel } from '@client/state/menu';

import {
  LIVERY_SAVE_DEBOUNCE_MS,
  ShipPanel,
  tabsForContext,
  type PanelContext,
  type PanelShipView,
} from './ship-panel';

let roots: Root[] = [];

const FULL_SHIP: PanelShipView = {
  classId: 'scout',
  hull: 80,
  shields: 40,
  energy: 100,
  livery: { hull: '#a11111', accent: '#11aa11', trim: '#1111aa' },
};

function renderPanel(
  context: PanelContext,
  over: Partial<Parameters<typeof ShipPanel>[0]> = {},
): HTMLDivElement {
  openPanel({
    id: 'ship-panel',
    title: 'SHIP',
    context,
    activeTab: over.activeTab ?? 'overview',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ShipPanel
        id="ship-panel"
        title="SHIP"
        context={context}
        activeTab={over.activeTab ?? 'overview'}
        ship={over.ship ?? FULL_SHIP}
        docked={over.docked ?? false}
        hold={over.hold ?? null}
        inventory={over.inventory ?? null}
        balance={over.balance ?? null}
        onMove={over.onMove ?? (() => {})}
        onSell={over.onSell}
        onRepair={over.onRepair ?? (() => {})}
        onLivery={over.onLivery ?? (() => {})}
        repairMessage={over.repairMessage ?? null}
        onClose={over.onClose ?? (() => {})}
      />,
    );
  });
  roots.push(root);
  return container;
}

/** Set a color input's value through the native setter (React's tracker). */
function setColor(container: HTMLDivElement, slot: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(
    `#ship-panel-livery-${slot}`,
  );
  if (!input) throw new Error(`livery ${slot} input missing`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('no native value setter');
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  __resetMenu();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('tabsForContext — the ONE tab set of the shared panel (TASK-53)', () => {
  it('docked ship: OVERVIEW / CARGO / REPAIR (Repair is the docked addition)', () => {
    expect([...tabsForContext('docked')]).toEqual(['overview', 'cargo', 'repair']);
  });

  it('in flight: OVERVIEW / CARGO (no Repair, no Sell)', () => {
    expect([...tabsForContext('flight')]).toEqual(['overview', 'cargo']);
  });

  it('on-foot dock terminal: OVERVIEW / CARGO / SELL (Sell is the dock addition)', () => {
    expect([...tabsForContext('dock')]).toEqual(['overview', 'cargo', 'sell']);
  });

  it('renders exactly the tabs of its context (no tab from another context)', () => {
    const el = renderPanel('flight');
    const tabs = el.querySelectorAll('#ship-panel [id^="ship-panel-tab-"]');
    expect(Array.from(tabs).map((t) => t.id)).toEqual([
      'ship-panel-tab-overview',
      'ship-panel-tab-cargo',
    ]);
    expect(el.querySelector('#ship-panel-tab-repair')).toBeNull();
    expect(el.querySelector('#ship-panel-tab-sell')).toBeNull();
  });
});

describe('ShipPanel tab switching (keyboard-first)', () => {
  it('starts on the requested tab (cargo for the cargo panel)', () => {
    const el = renderPanel('flight', { activeTab: 'cargo' });
    expect(el.querySelector('#ship-panel-tab-cargo')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('switches on click and moves aria-pressed', () => {
    const el = renderPanel('docked');
    act(() => {
      el.querySelector<HTMLButtonElement>('#ship-panel-tab-repair')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(el.querySelector('#ship-panel-tab-repair')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('#ship-panel-tab-overview')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('ArrowRight / ArrowLeft cycle the tabs and the FOCUS follows the tab', () => {
    const el = renderPanel('docked');
    const send = (key: string): void => {
      const target = document.activeElement as HTMLElement;
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    };
    // The focus trap activates on the first focusable (the close button) —
    // move focus onto the active tab, then arrow across.
    act(() => {
      el.querySelector<HTMLButtonElement>('#ship-panel-tab-overview')?.focus();
    });
    send('ArrowRight');
    expect(el.querySelector('#ship-panel-tab-cargo')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement?.id).toBe('ship-panel-tab-cargo');
    send('ArrowRight');
    expect(el.querySelector('#ship-panel-tab-repair')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement?.id).toBe('ship-panel-tab-repair');
    send('ArrowLeft');
    expect(el.querySelector('#ship-panel-tab-cargo')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ShipPanel Repair tab — docked-gated (TASK-23 preview)', () => {
  it('shows the cost preview and an ENABLED Repair button when docked', () => {
    const onRepair = vi.fn();
    const el = renderPanel('docked', { docked: true, activeTab: 'repair', onRepair });
    // hull 80/100 → ceil(0.2·10)=2, shields 40/50 → ceil(0.2·5)=1 → 3 cr.
    expect(el.querySelector('#ship-panel-repair-cost')?.textContent).toContain('repair cost: 3 cr');
    const btn = el.querySelector<HTMLButtonElement>('#ship-panel-repair');
    expect(btn?.disabled).toBe(false);
    expect(el.querySelector('#ship-panel-repair-reason')).toBeNull();
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it('DISABLES the Repair button with a reason when not docked', () => {
    const onRepair = vi.fn();
    const el = renderPanel('docked', { docked: false, activeTab: 'repair', onRepair });
    const btn = el.querySelector<HTMLButtonElement>('#ship-panel-repair');
    expect(btn?.disabled).toBe(true);
    expect(el.querySelector('#ship-panel-repair-reason')?.textContent).toContain(
      'Repair requires a docked ship',
    );
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('renders the transient repair message as an alert', () => {
    const el = renderPanel('docked', {
      docked: true,
      activeTab: 'repair',
      repairMessage: 'need 25 credits, have 12',
    });
    expect(el.querySelector('#ship-panel [role="alert"]')?.textContent).toContain(
      'need 25 credits, have 12',
    );
  });
});

describe('ShipPanel Overview — stats + livery debounce (TASK-21)', () => {
  it('shows the class stats + hull/shield/energy bars from the 10 Hz view', () => {
    const el = renderPanel('docked');
    expect(el.querySelector('#ship-panel')?.textContent).toContain('Sparrow Scout');
    expect(el.querySelector('#ship-panel')?.textContent).toContain('max velocity');
    const hullBar = el.querySelector('#ship-panel [aria-label="HULL"]');
    expect(hullBar?.getAttribute('aria-valuenow')).toBe('80');
  });

  it('5 rapid livery changes → EXACTLY ONE onLivery call (500 ms debounce)', async () => {
    vi.useFakeTimers();
    const onLivery = vi.fn<(c: Livery) => void>();
    const el = renderPanel('docked', { onLivery });
    // Five rapid picker drags — each resets the debounce timer.
    setColor(el, 'hull', '#123456');
    setColor(el, 'hull', '#234567');
    setColor(el, 'accent', '#345678');
    setColor(el, 'hull', '#456789');
    setColor(el, 'trim', '#56789a');
    expect(onLivery).not.toHaveBeenCalled(); // inside the debounce window
    act(() => {
      vi.advanceTimersByTime(LIVERY_SAVE_DEBOUNCE_MS - 1);
    });
    expect(onLivery).not.toHaveBeenCalled(); // still 1 ms short
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLivery).toHaveBeenCalledTimes(1); // ONE request for five changes
    expect(onLivery).toHaveBeenCalledWith({
      hull: '#456789',
      accent: '#345678',
      trim: '#56789a',
    });
  });

  it('a fresh server livery (the entity_update echo) resets the draft WITHOUT saving', async () => {
    vi.useFakeTimers();
    const onLivery = vi.fn<(c: Livery) => void>();
    const echo: Livery = { hull: '#00ff00', accent: '#000000', trim: '#ffffff' };
    const el = renderPanel('docked', { onLivery });
    setColor(el, 'hull', '#0000ff');
    act(() => vi.advanceTimersByTime(LIVERY_SAVE_DEBOUNCE_MS));
    expect(onLivery).toHaveBeenCalledTimes(1);
    // The server echoes the save: the 10 Hz entity arrives with the new
    // livery — the draft follows it, and NO second request fires.
    act(() => {
      el.querySelector('#ship-panel-livery-hull')?.dispatchEvent(
        new Event('input', { bubbles: true }), // no-op: value already current
      );
    });
    // Re-mount with the echoed livery (the 10 Hz update's effect on the view).
    for (const root of roots) act(() => root.unmount());
    roots = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ShipPanel
          id="ship-panel"
          title="SHIP"
          context="docked"
          activeTab="overview"
          ship={{ ...FULL_SHIP, livery: echo }}
          docked
          hold={null}
          inventory={null}
          balance={null}
          onMove={() => {}}
          onLivery={onLivery}
          repairMessage={null}
          onClose={() => {}}
        />,
      );
    });
    roots.push(root);
    expect(container.querySelector<HTMLInputElement>('#ship-panel-livery-hull')?.value).toBe(
      '#00ff00',
    );
    act(() => vi.advanceTimersByTime(LIVERY_SAVE_DEBOUNCE_MS * 2));
    expect(onLivery).toHaveBeenCalledTimes(1); // the echo never re-saves
  });
});
