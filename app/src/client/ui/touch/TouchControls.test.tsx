// @vitest-environment happy-dom
/**
 * TASK-91: TouchControls — the flight touch layout feeding the shared
 * TouchInputSource.
 *
 * Synthetic PointerEvents drive the widgets (the TASK-90 pattern): the LEFT
 * stick writes thrust/yaw, the RIGHT stick writes pitch/roll (up-positive
 * y), the regime gates the VTOL (atmosphere) / BOOST (space) button, the
 * container renders nothing when disabled or on the surface, and held
 * channels are cleared on disable / unmount / regime flip. The touchDebug
 * hook's passthrough + live snapshot are covered too.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TouchInputSource } from '@client/input/touch';
import { bindTouchDebug, installTouchDebug } from '@client/touch-debug';
import type { WeaponId } from '@shared/weapons';

import { TouchControls } from './TouchControls';

let roots: Root[] = [];
let source: TouchInputSource;

/** Mount the container; returns the document container element. */
function renderControls(props: Partial<Parameters<typeof TouchControls>[0]> = {}): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TouchControls
        enabled={props.enabled ?? true}
        regime={props.regime ?? 'space'}
        source={props.source ?? source}
        onFire={props.onFire}
        onWeapon={props.onWeapon}
        onTarget={props.onTarget}
        weapon={props.weapon}
      />,
    );
  });
  roots.push(root);
  return container;
}

/** Dispatch a synthetic PointerEvent (happy-dom implements PointerEvent). */
function pointer(type: string, x: number, y: number, target: Element): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        isPrimary: true,
      }),
    );
  });
}

let combat: {
  onFire: ReturnType<typeof vi.fn<() => void>>;
  onWeapon: ReturnType<typeof vi.fn<(w: WeaponId) => void>>;
  onTarget: ReturnType<typeof vi.fn<() => void>>;
  weapon: WeaponId;
};

beforeEach(() => {
  source = new TouchInputSource();
  document.body.innerHTML = '';
  roots.forEach((r) => r.unmount());
  roots = [];
  vi.clearAllMocks();
  combat = {
    onFire: vi.fn<() => void>(),
    onWeapon: vi.fn<(w: WeaponId) => void>(),
    onTarget: vi.fn<() => void>(),
    weapon: 'laser',
  };
});

afterEach(() => {
  roots.forEach((r) => r.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('TouchControls — layout and regime gating', () => {
  it('renders the dual sticks + the BOOST button in space (no VTOL)', () => {
    renderControls({ regime: 'space' });
    expect(document.getElementById('touch-controls')).not.toBeNull();
    expect(document.getElementById('touch-stick-left')).not.toBeNull();
    expect(document.getElementById('touch-stick-right')).not.toBeNull();
    expect(document.getElementById('touch-btn-boost')?.textContent).toContain('BOOST');
    expect(document.getElementById('touch-btn-vtol')).toBeNull();
  });

  it('renders the dual sticks + the VTOL button in atmosphere (no BOOST)', () => {
    renderControls({ regime: 'atmosphere' });
    expect(document.getElementById('touch-btn-vtol')?.textContent).toContain('VTOL');
    expect(document.getElementById('touch-btn-boost')).toBeNull();
  });

  it('renders nothing when disabled (the TASK-89 no-op)', () => {
    renderControls({ enabled: false });
    expect(document.getElementById('touch-controls')).toBeNull();
  });

  it('renders nothing on the surface (the on-foot layout owns it)', () => {
    renderControls({ regime: 'surface' });
    expect(document.getElementById('touch-controls')).toBeNull();
  });
});

describe('TouchControls — sticks feed the source (up-positive y)', () => {
  it('left stick: drag up = thrust +1, drag right = yaw +1, release = 0', () => {
    const c = renderControls({ regime: 'space' });
    const left = c.querySelector('[aria-label="thrust and yaw stick"]')!;
    pointer('pointerdown', 0, -64, left);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0 });
    pointer('pointermove', 64, 0, left);
    expect(source.snapshot()).toEqual({ thrust: 0, yaw: 1 });
    pointer('pointerup', 64, 0, left);
    expect(source.snapshot()).toEqual({ thrust: 0, yaw: 0 });
  });

  it('right stick: drag up = pitch +1, drag left = roll -1', () => {
    const c = renderControls({ regime: 'space' });
    const right = c.querySelector('[aria-label="pitch and roll stick"]')!;
    pointer('pointerdown', 0, -64, right);
    expect(source.snapshot()).toEqual({ pitch: 1, roll: 0 });
    pointer('pointermove', -64, 0, right);
    expect(source.snapshot()).toEqual({ pitch: 0, roll: -1 });
  });

  it('a stick never clobbers a held button (setChannel is partial)', () => {
    const c = renderControls({ regime: 'atmosphere' });
    const vtol = c.querySelector('[aria-label="VTOL"]')!;
    pointer('pointerdown', 0, 0, vtol);
    const left = c.querySelector('[aria-label="thrust and yaw stick"]')!;
    pointer('pointerdown', 0, -64, left);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0, vtol: true });
  });
});

describe('TouchControls — buttons feed the source', () => {
  it('VTOL: press = vtol true, release = vtol false (atmosphere)', () => {
    const c = renderControls({ regime: 'atmosphere' });
    const vtol = c.querySelector('[aria-label="VTOL"]')!;
    pointer('pointerdown', 0, 0, vtol);
    expect(source.snapshot()).toEqual({ vtol: true });
    pointer('pointerup', 0, 0, vtol);
    expect(source.snapshot()).toEqual({ vtol: false });
  });

  it('BOOST: press = boost true, release = boost false (space)', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    pointer('pointerdown', 0, 0, boost);
    expect(source.snapshot()).toEqual({ boost: true });
    pointer('pointerup', 0, 0, boost);
    expect(source.snapshot()).toEqual({ boost: false });
  });
});

describe('TouchControls — channel hygiene across regime / enable flips', () => {
  it('a held BOOST is cleared when the regime flips to atmosphere', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    pointer('pointerdown', 0, 0, boost);
    expect(source.snapshot().boost).toBe(true);
    act(() => {
      roots[0].render(<TouchControls enabled regime="atmosphere" source={source} />);
    });
    // The unmounted button never fires onRelease — the flip must clear it.
    expect(source.snapshot().boost).toBe(false);
  });

  it('disabling clears every held channel', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    pointer('pointerdown', 0, 0, boost);
    const left = c.querySelector('[aria-label="thrust and yaw stick"]')!;
    pointer('pointerdown', 0, -64, left);
    act(() => {
      roots[0].render(<TouchControls enabled={false} regime="space" source={source} />);
    });
    expect(document.getElementById('touch-controls')).toBeNull();
    expect(source.snapshot()).toEqual({});
  });

  it('unmounting clears every held channel', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    pointer('pointerdown', 0, 0, boost);
    act(() => roots[0].unmount());
    expect(source.snapshot()).toEqual({});
  });
});

describe('TouchControls — the COMBAT cluster (TASK-92)', () => {
  const withCombat = (extra: Partial<Parameters<typeof TouchControls>[0]> = {}): HTMLDivElement =>
    renderControls({
      regime: 'space',
      onFire: combat.onFire,
      onWeapon: combat.onWeapon,
      onTarget: combat.onTarget,
      weapon: combat.weapon,
      ...extra,
    });

  it('renders FIRE / LASER / MISSILE / TARGET when the combat callbacks are wired', () => {
    withCombat();
    expect(document.getElementById('touch-btn-fire')?.textContent).toContain('FIRE');
    expect(document.getElementById('touch-btn-weapon-laser')?.textContent).toContain('LASER');
    expect(document.getElementById('touch-btn-weapon-missile')?.textContent).toContain('MISSILE');
    expect(document.getElementById('touch-btn-target')?.textContent).toContain('TARGET');
  });

  it('renders the flight-only layout when no combat callbacks are given', () => {
    renderControls({ regime: 'space' });
    for (const id of [
      'touch-btn-fire',
      'touch-btn-weapon-laser',
      'touch-btn-weapon-missile',
      'touch-btn-target',
    ]) {
      expect(document.getElementById(id), `${id} absent`).toBeNull();
    }
  });

  it('FIRE: one press = exactly one onFire; the held accent is visual only', () => {
    const c = withCombat();
    const fire = c.querySelector('[aria-label="FIRE"]')!;
    pointer('pointerdown', 0, 0, fire);
    expect(combat.onFire).toHaveBeenCalledTimes(1);
    expect(fire.getAttribute('aria-pressed')).toBe('true');
    // Release never re-fires (the LMB path is one-shot per click).
    pointer('pointerup', 0, 0, fire);
    expect(combat.onFire).toHaveBeenCalledTimes(1);
    expect(fire.getAttribute('aria-pressed')).toBe('false');
    // A second full press fires exactly once more.
    pointer('pointerdown', 0, 0, fire);
    pointer('pointerup', 0, 0, fire);
    expect(combat.onFire).toHaveBeenCalledTimes(2);
  });

  it('LASER / MISSILE call onWeapon with the right id (the shared select path)', () => {
    const c = withCombat();
    pointer('pointerdown', 0, 0, c.querySelector('[aria-label="LASER"]')!);
    expect(combat.onWeapon).toHaveBeenCalledTimes(1);
    expect(combat.onWeapon).toHaveBeenLastCalledWith('laser');
    pointer('pointerdown', 0, 0, c.querySelector('[aria-label="MISSILE"]')!);
    expect(combat.onWeapon).toHaveBeenCalledTimes(2);
    expect(combat.onWeapon).toHaveBeenLastCalledWith('missile');
  });

  it('the active weapon button shows the pressed accent', () => {
    const c = withCombat();
    expect(c.querySelector('[aria-label="LASER"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(c.querySelector('[aria-label="MISSILE"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('TARGET: one press = exactly one onTarget (the shared toggle)', () => {
    const c = withCombat();
    const target = c.querySelector('[aria-label="TARGET"]')!;
    pointer('pointerdown', 0, 0, target);
    expect(combat.onTarget).toHaveBeenCalledTimes(1);
    pointer('pointerup', 0, 0, target);
    pointer('pointerdown', 0, 0, target);
    pointer('pointerup', 0, 0, target);
    expect(combat.onTarget).toHaveBeenCalledTimes(2);
  });

  it('the combat cluster is absent on the surface (the on-foot layout owns it)', () => {
    withCombat({ regime: 'surface' });
    expect(document.getElementById('touch-btn-fire')).toBeNull();
    expect(document.getElementById('touch-controls')).toBeNull();
  });
});

describe('touchDebug — the deterministic e2e driver', () => {
  it('setChannel delegates to the bound source; channels stays live', () => {
    const state = installTouchDebug();
    expect(state, 'DEV build installs the hook').not.toBeNull();
    const src = new TouchInputSource();
    bindTouchDebug(state, () => src);
    state!.setChannel({ thrust: 1 });
    state!.setChannel({ vtol: true });
    expect(src.snapshot()).toEqual({ thrust: 1, vtol: true });
    // The live getter tracks the source (a joystick move shows up too).
    expect(state!.channels).toEqual({ thrust: 1, vtol: true });
    src.setChannel({ thrust: 0.5 });
    expect(state!.channels).toEqual({ thrust: 0.5, vtol: true });
    state!.clear();
    expect(src.snapshot()).toEqual({});
  });

  it('is a no-op passthrough when never bound (no crash)', async () => {
    // A fresh module instance (the hook's binding is module state; the test
    // above bound a source to the shared instance).
    vi.resetModules();
    const { installTouchDebug: freshInstall } = await import('@client/touch-debug');
    const state = freshInstall();
    expect(state).not.toBeNull();
    state!.setChannel({ thrust: 1 });
    expect(state!.channels).toEqual({});
  });
});

describe('touchDebug — the combat bridge (TASK-92)', () => {
  it('fire / setWeapon / toggleTarget delegate; state is a live snapshot', async () => {
    // A fresh module instance (the combat binding is module state).
    vi.resetModules();
    const { installTouchDebug, bindTouchCombat } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    const calls: string[] = [];
    let snap: { weapon: WeaponId; locked: boolean } = { weapon: 'laser', locked: false };
    bindTouchCombat(state, () => ({
      fire: () => calls.push('fire'),
      setWeapon: (w) => {
        snap = { weapon: w, locked: snap.locked };
        calls.push(`set:${w}`);
      },
      toggleTarget: () => {
        snap = { ...snap, locked: !snap.locked };
        calls.push('target');
      },
      snapshot: () => snap,
    }));
    state.fire();
    state.setWeapon('missile');
    state.toggleTarget();
    expect(calls).toEqual(['fire', 'set:missile', 'target']);
    // The snapshot is live: it tracks the bridge's state, not a copy.
    expect(state.state).toEqual({ weapon: 'missile', locked: true });
  });

  it('combat is a no-op before the combat bridge is bound (no crash)', async () => {
    vi.resetModules();
    const { installTouchDebug } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    expect(() => {
      state!.fire();
      state!.setWeapon('laser');
      state!.toggleTarget();
    }).not.toThrow();
    expect(state!.state).toBeNull();
  });
});
