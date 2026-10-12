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
 * hook's passthrough + live snapshot are covered too. TASK-101: the FIRE
 * button is a functional hold (a fake rAF clock proves the press fires
 * immediately, release / unmount / disembark / disable stop the loop).
 * TASK-104: the held loop PACES intents at most one per 333 ms (the fake
 * clock advances performance.now 16 ms per frame, so the pace is
 * deterministic — a 333 ms interval is ≈ 21 frames).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TouchInputSource } from '@client/input/touch';
import { __resetBoost, boostOn, setBoostOn } from '@client/state/boost';
import { __resetHover, hoverOn, setHoverOn } from '@client/state/hover';
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
        onFoot={props.onFoot}
        onInteractPress={props.onInteractPress}
        onInteractRelease={props.onInteractRelease}
        onDrop={props.onDrop}
        onMenu={props.onMenu}
        touchCapable={props.touchCapable}
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

/**
 * The fake rAF clock: requestAnimationFrame queues, frames(n) advances n
 * frames (each queued callback schedules the next loop iteration).
 * TASK-104: each fake frame also advances the fake `performance.now` by
 * FRAME_MS (16 ms), so the FIRE hold's 333 ms pace elapses deterministically
 * across simulated frames (a pace of 333 ms ≈ 21 frames).
 */
const FRAME_MS = 16;
function fakeRaf(): { frames: (n: number) => void } {
  const queue: FrameRequestCallback[] = [];
  let t = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.splice(id - 1, 1);
  });
  // Spy (not stubGlobal) so the rest of the Performance API stays intact —
  // only `now` is fake, and `vi.restoreAllMocks()` in afterEach restores it.
  vi.spyOn(performance, 'now').mockImplementation(() => t);
  return {
    frames: (n: number) => {
      for (let i = 0; i < n; i++) {
        t += FRAME_MS;
        act(() => {
          const pending = queue.splice(0, queue.length);
          for (const cb of pending) cb(t);
        });
      }
    },
  };
}

beforeEach(() => {
  source = new TouchInputSource();
  __resetHover(); // the shared hover store is module state (TASK-107)
  __resetBoost(); // the shared boost store is module state (TASK-108)
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
  vi.unstubAllGlobals(); // the fake rAF clock (TASK-101)
  vi.restoreAllMocks(); // the fake performance.now (TASK-104)
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

  it('pad-docked (surface, in-ship) renders the FLIGHT layout incl. MENU, no BOOST (TASK-97)', () => {
    // The wire regime of a pad-docked ship is 'surface'; the player is IN
    // the ship (not onFoot). The overlay must show the atmosphere-scheme
    // flight layout (VTOL = the ' ' lift, per dockedFlightScheme) — the
    // pre-fix code returned null here, stranding a touch-only player.
    renderControls({ regime: 'surface', onMenu: vi.fn<() => void>() });
    expect(document.getElementById('touch-controls')).not.toBeNull();
    expect(document.getElementById('touch-stick-left')).not.toBeNull();
    expect(document.getElementById('touch-stick-right')).not.toBeNull();
    expect(document.getElementById('touch-btn-vtol')?.textContent).toContain('VTOL');
    expect(document.getElementById('touch-btn-menu')?.textContent).toContain('MENU');
    expect(document.getElementById('touch-btn-boost')).toBeNull();
  });

  it('disabled + touchCapable + onMenu: a lone MENU renders while the sticks are absent (TASK-97)', () => {
    // Touch OFF on a touch-capable device: a lone MENU button keeps the ESC
    // layer (→ SETTINGS → TOUCH CONTROLS) reachable; channels stay empty.
    renderControls({ enabled: false, touchCapable: true, onMenu: vi.fn<() => void>() });
    expect(document.getElementById('touch-controls')).not.toBeNull();
    expect(document.getElementById('touch-btn-menu')?.textContent).toContain('MENU');
    expect(document.getElementById('touch-stick-left')).toBeNull();
    expect(document.getElementById('touch-stick-right')).toBeNull();
    expect(source.snapshot()).toEqual({});
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
    const c = renderControls({ regime: 'space' });
    // The legacy press-hold boost channel (the __TOUCH__ bridge / the
    // keyboard Shift path) — a stick write must not clear it.
    source.setChannel({ boost: true });
    const left = c.querySelector('[aria-label="thrust and yaw stick"]')!;
    pointer('pointerdown', 0, -64, left);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0, boost: true });
  });
});

describe('TouchControls — the VTOL button is the hover TOGGLE (TASK-107)', () => {
  it('one tap flips the hover store ON, the next tap OFF; release never re-toggles', () => {
    const c = renderControls({ regime: 'atmosphere' });
    const vtol = c.querySelector('[aria-label="VTOL"]')!;
    expect(hoverOn()).toBe(false);
    expect(vtol.getAttribute('aria-pressed')).toBe('false');
    pointer('pointerdown', 0, 0, vtol);
    expect(hoverOn(), 'tap ON').toBe(true);
    expect(vtol.getAttribute('aria-pressed'), 'accent mirrors the store').toBe('true');
    pointer('pointerup', 0, 0, vtol);
    expect(hoverOn(), 'release is a no-op (a held tap must not re-toggle)').toBe(true);
    pointer('pointerdown', 0, 0, vtol);
    pointer('pointerup', 0, 0, vtol);
    expect(hoverOn(), 'tap OFF').toBe(false);
    expect(vtol.getAttribute('aria-pressed')).toBe('false');
  });

  it('does NOT write the vtol virtual key (the store is driven directly, the press-hold path stays legacy)', () => {
    const c = renderControls({ regime: 'atmosphere' });
    const vtol = c.querySelector('[aria-label="VTOL"]')!;
    pointer('pointerdown', 0, 0, vtol);
    pointer('pointerup', 0, 0, vtol);
    expect(source.snapshot(), 'no channel written by the toggle').toEqual({});
    expect(hoverOn()).toBe(true);
  });

  it('reflects a store change made elsewhere (keyboard Space press, live subscribe)', () => {
    const c = renderControls({ regime: 'atmosphere' });
    const vtol = c.querySelector('[aria-label="VTOL"]')!;
    act(() => setHoverOn(true)); // the keyboard path
    expect(vtol.getAttribute('aria-pressed'), 'accent tracks the store').toBe('true');
  });

  it('the toggle survives the IN-SHIP touchdown (surface flip, not on foot)', () => {
    // Hover is CLIENT state: the in-ship landing flip must not clear it
    // (the auto-disengage is the wire handler's job — space / egress only,
    // main.tsx), so a hovering ship settling onto a pad keeps its hold.
    const c = renderControls({ regime: 'atmosphere' });
    pointer('pointerdown', 0, 0, c.querySelector('[aria-label="VTOL"]')!);
    pointer('pointerup', 0, 0, c.querySelector('[aria-label="VTOL"]')!);
    expect(hoverOn()).toBe(true);
    act(() => {
      roots[0].render(<TouchControls enabled regime="surface" source={source} />);
    });
    expect(hoverOn(), 'hover survives the in-ship touchdown').toBe(true);
  });

  it('liftoff (surface → atmosphere, in-ship) KEEPS the hover toggle + the held thrust (TASK-97)', () => {
    const c = renderControls({ regime: 'surface' });
    const left = c.querySelector('[aria-label="thrust and yaw stick"]')!;
    pointer('pointerdown', 0, 0, c.querySelector('[aria-label="VTOL"]')!);
    pointer('pointerup', 0, 0, c.querySelector('[aria-label="VTOL"]')!);
    pointer('pointerdown', 0, -64, left);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0 });
    expect(hoverOn()).toBe(true);
    // LIFTOFF: the regime flips to atmosphere while onFoot stays false —
    // the finger is still on the stick and the server is taking the ship
    // off (the keyboard's held keys survive the flip; touch must match).
    act(() => {
      roots[0].render(<TouchControls enabled regime="atmosphere" source={source} />);
    });
    expect(source.snapshot(), 'thrust survives the flip').toEqual({ thrust: 1, yaw: 0 });
    expect(hoverOn(), 'hover survives the flip').toBe(true);
    // DISSEMBARK (onFoot flips true) clears the CHANNELS (the ' ' leak
    // rule) — the hover store is the wire handler's, not this flip's.
    act(() => {
      roots[0].render(<TouchControls enabled regime="surface" source={source} onFoot />);
    });
    expect(source.snapshot()).toEqual({});
  });
});

describe('TouchControls — the BOOST button is the boost TOGGLE (TASK-108)', () => {
  it('one tap flips the boost store ON, the next tap OFF; release never re-toggles', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    expect(boostOn()).toBe(false);
    expect(boost.getAttribute('aria-pressed')).toBe('false');
    pointer('pointerdown', 0, 0, boost);
    expect(boostOn(), 'tap ON').toBe(true);
    expect(boost.getAttribute('aria-pressed'), 'accent mirrors the store').toBe('true');
    pointer('pointerup', 0, 0, boost);
    expect(boostOn(), 'release is a no-op (a held tap must not re-toggle)').toBe(true);
    pointer('pointerdown', 0, 0, boost);
    pointer('pointerup', 0, 0, boost);
    expect(boostOn(), 'tap OFF').toBe(false);
    expect(boost.getAttribute('aria-pressed')).toBe('false');
  });

  it('does NOT write the boost virtual key (the store is driven directly, the press-hold path stays legacy)', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    pointer('pointerdown', 0, 0, boost);
    pointer('pointerup', 0, 0, boost);
    expect(source.snapshot(), 'no channel written by the toggle').toEqual({});
    expect(boostOn()).toBe(true);
  });

  it('reflects a store change made elsewhere (keyboard Shift press, live subscribe)', () => {
    const c = renderControls({ regime: 'space' });
    const boost = c.querySelector('[aria-label="BOOST"]')!;
    act(() => setBoostOn(true)); // the keyboard path
    expect(boost.getAttribute('aria-pressed'), 'accent tracks the store').toBe('true');
  });
});

describe('TouchControls — channel hygiene across regime / enable flips', () => {
  it('a held BOOST channel (legacy press-hold path) is cleared on the atmosphere flip', () => {
    // TASK-108: the BOOST BUTTON no longer writes the channel (it drives
    // the store), but the legacy press-hold path (the __TOUCH__ bridge)
    // can — the flip must clear it so the unmounted button's onRelease
    // can't leak the demand into the atmosphere scheme.
    renderControls({ regime: 'space' });
    source.setChannel({ boost: true });
    expect(source.snapshot().boost).toBe(true);
    act(() => {
      roots[0].render(<TouchControls enabled regime="atmosphere" source={source} />);
    });
    expect(source.snapshot().boost).toBe(false);
  });

  it('the toggle store SURVIVES the layout flip (auto-offer is the wire handler\'s job)', () => {
    renderControls({ regime: 'space' });
    setBoostOn(true); // the keyboard / touch toggle
    act(() => {
      roots[0].render(<TouchControls enabled regime="atmosphere" source={source} />);
    });
    expect(boostOn(), 'the store is wire-driven, not layout-driven').toBe(true);
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

  it('on-foot JUMP writes the " " virtual key, NOT the hover store (TASK-107 split)', () => {
    // The deliberate ' ' collision (vtol+jump) is now one-way for the
    // store: on foot JUMP stays the held-key channel (the on-foot loop
    // reads it), and a JUMP tap never touches the hover toggle.
    const c = renderControls({ regime: 'surface', onFoot: true });
    const jump = c.querySelector('[aria-label="JUMP"]')!;
    pointer('pointerdown', 0, 0, jump);
    expect(source.snapshot()).toEqual({ jump: true });
    expect(hoverOn(), 'JUMP must not toggle hover').toBe(false);
    pointer('pointerup', 0, 0, jump);
    expect(source.snapshot()).toEqual({ jump: false });
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

  it('FIRE: a tap fires exactly once (the first shot); release never re-fires', () => {
    const c = withCombat();
    const fire = c.querySelector('[aria-label="FIRE"]')!;
    pointer('pointerdown', 0, 0, fire);
    expect(combat.onFire).toHaveBeenCalledTimes(1);
    // The pressed accent is the FUNCTIONAL held state now (TASK-101).
    expect(fire.getAttribute('aria-pressed')).toBe('true');
    // Release stops the loop (no frames elapse here, so no further calls).
    pointer('pointerup', 0, 0, fire);
    expect(combat.onFire).toHaveBeenCalledTimes(1);
    expect(fire.getAttribute('aria-pressed')).toBe('false');
    // A second tap fires exactly once more.
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

  it('the combat cluster is absent while on foot (the on-foot layout owns it)', () => {
    withCombat({ regime: 'surface', onFoot: true });
    expect(document.getElementById('touch-btn-fire')).toBeNull();
    expect(document.getElementById('touch-stick-move')).not.toBeNull();
  });

  it('the combat cluster rides the surface-in-ship flight layout (TASK-97)', () => {
    withCombat({ regime: 'surface' });
    expect(document.getElementById('touch-btn-fire')?.textContent).toContain('FIRE');
  });
});

describe('TouchControls — FIRE hold-to-fire (TASK-101)', () => {
  const withCombat = (extra: Partial<Parameters<typeof TouchControls>[0]> = {}): HTMLDivElement =>
    renderControls({
      regime: 'space',
      onFire: combat.onFire,
      onWeapon: combat.onWeapon,
      onTarget: combat.onTarget,
      weapon: combat.weapon,
      ...extra,
    });
  const fireButton = (c: Element): Element => c.querySelector('[aria-label="FIRE"]')!;

  it('a press fires immediately; the held loop paces at most one fire per 333 ms (TASK-104)', () => {
    const raf = fakeRaf();
    const c = withCombat();
    pointer('pointerdown', 0, 0, fireButton(c));
    expect(combat.onFire).toHaveBeenCalledTimes(1); // the immediate first shot
    expect(fireButton(c).getAttribute('aria-pressed')).toBe('true');
    // 20 frames × 16 ms = 320 ms < 333 → the pace has NOT elapsed (no fire).
    raf.frames(20);
    expect(combat.onFire).toHaveBeenCalledTimes(1);
    // Frame 21 → t = 336 ms ≥ 333 → exactly one paced intent.
    raf.frames(1);
    expect(combat.onFire).toHaveBeenCalledTimes(2);
    // The next pace lands 333 ms later (≈ 21 more frames) — not per frame.
    raf.frames(21);
    expect(combat.onFire).toHaveBeenCalledTimes(3);
    pointer('pointerup', 0, 0, fireButton(c));
  });

  it('releasing stops the fire loop (no further calls on later frames)', () => {
    const raf = fakeRaf();
    const c = withCombat();
    pointer('pointerdown', 0, 0, fireButton(c));
    raf.frames(21);
    const held = combat.onFire.mock.calls.length;
    expect(held).toBe(2); // immediate + one paced fire
    pointer('pointerup', 0, 0, fireButton(c));
    expect(fireButton(c).getAttribute('aria-pressed')).toBe('false');
    raf.frames(42);
    expect(combat.onFire).toHaveBeenCalledTimes(held); // the loop is dead
  });

  it('a second press after release starts a fresh loop', () => {
    const raf = fakeRaf();
    const c = withCombat();
    pointer('pointerdown', 0, 0, fireButton(c));
    pointer('pointerup', 0, 0, fireButton(c));
    expect(combat.onFire).toHaveBeenCalledTimes(1);
    raf.frames(30);
    expect(combat.onFire).toHaveBeenCalledTimes(1); // the stopped loop stays stopped
    pointer('pointerdown', 0, 0, fireButton(c));
    expect(combat.onFire).toHaveBeenCalledTimes(2); // a fresh press fires at once
    raf.frames(21);
    expect(combat.onFire).toHaveBeenCalledTimes(3); // the fresh loop paces
    pointer('pointerup', 0, 0, fireButton(c));
  });

  it('unmounting while held stops the fire loop', () => {
    const raf = fakeRaf();
    const c = withCombat();
    pointer('pointerdown', 0, 0, fireButton(c));
    raf.frames(2);
    const held = combat.onFire.mock.calls.length;
    act(() => roots[0].unmount());
    raf.frames(3);
    expect(combat.onFire).toHaveBeenCalledTimes(held); // no firing with no control
  });

  it('a disembark flip (the on-foot layout replaces the flight one) stops the loop', () => {
    const raf = fakeRaf();
    withCombat();
    pointer('pointerdown', 0, 0, fireButton(document.getElementById('touch-controls')!));
    raf.frames(2);
    const held = combat.onFire.mock.calls.length;
    // The removed FIRE button's onRelease never fires — the flip must stop
    // the loop so the ship never fires with no visible control.
    act(() => {
      roots[0].render(
        <TouchControls
          enabled
          regime="surface"
          source={source}
          onFire={combat.onFire}
          onWeapon={combat.onWeapon}
          onTarget={combat.onTarget}
          weapon={combat.weapon}
          onFoot
        />,
      );
    });
    raf.frames(3);
    expect(combat.onFire).toHaveBeenCalledTimes(held);
  });

  it('disabling stops the fire loop', () => {
    const raf = fakeRaf();
    withCombat();
    pointer('pointerdown', 0, 0, fireButton(document.getElementById('touch-controls')!));
    raf.frames(2);
    const held = combat.onFire.mock.calls.length;
    act(() => {
      roots[0].render(<TouchControls enabled={false} regime="space" source={source} />);
    });
    raf.frames(3);
    expect(combat.onFire).toHaveBeenCalledTimes(held);
  });
});

describe('TouchControls — TASK-102 button sizes + press haptics', () => {
  /** The rendered hit-target width/height of a button by its label. */
  const hitSize = (label: string): { w: string; h: string } => {
    const el = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    return { w: el.style.width, h: el.style.height };
  };
  const withCombat = (extra: Partial<Parameters<typeof TouchControls>[0]> = {}): HTMLDivElement =>
    renderControls({
      regime: 'space',
      onFire: combat.onFire,
      onWeapon: combat.onWeapon,
      onTarget: combat.onTarget,
      weapon: combat.weapon,
      ...extra,
    });

  it('LASER / MISSILE (combat) and TARGET are on the 56 px floor', () => {
    withCombat();
    for (const label of ['LASER', 'MISSILE', 'TARGET']) {
      expect(hitSize(label).w, `${label} width`).toBe('56px');
      expect(hitSize(label).h, `${label} height`).toBe('56px');
    }
    // FIRE keeps its 72 px size (already above the floor).
    expect(hitSize('FIRE').w).toBe('72px');
  });

  it('RUN / DROP (on-foot) are 56 px; JUMP / INTERACT stay 64 px', () => {
    renderControls({
      regime: 'surface',
      onFoot: true,
      onInteractPress: vi.fn<() => void>(),
      onInteractRelease: vi.fn<() => void>(),
      onDrop: vi.fn<() => void>(),
    });
    for (const label of ['RUN', 'DROP']) {
      expect(hitSize(label).w, `${label} width`).toBe('56px');
      expect(hitSize(label).h, `${label} height`).toBe('56px');
    }
    for (const label of ['JUMP', 'INTERACT']) {
      expect(hitSize(label).w, `${label} width`).toBe('64px');
    }
  });

  it('FIRE: the press vibrates once, the paced hold loop never does', () => {
    const vibrate = vi.fn<() => boolean>();
    vi.stubGlobal('navigator', { ...navigator, vibrate });
    const raf = fakeRaf();
    withCombat();
    const fire = document.querySelector('[aria-label="FIRE"]')!;
    pointer('pointerdown', 0, 0, fire);
    expect(vibrate, 'the press pulses once').toHaveBeenCalledTimes(1);
    expect(combat.onFire).toHaveBeenCalledTimes(1); // the immediate first shot
    raf.frames(42); // 672 ms held — two more PACED intents (3 total), no buzz
    expect(combat.onFire).toHaveBeenCalledTimes(3);
    expect(vibrate, 'the hold loop must not buzz per fire').toHaveBeenCalledTimes(1);
    pointer('pointerup', 0, 0, fire);
    raf.frames(3);
    expect(combat.onFire).toHaveBeenCalledTimes(3); // the loop is dead
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});

describe('TouchControls — the ON-FOOT layout (TASK-93)', () => {
  const onFoot = {
    onFoot: true,
    onInteractPress: vi.fn<() => void>(),
    onInteractRelease: vi.fn<() => void>(),
    onDrop: vi.fn<() => void>(),
  };
  const renderOnFoot = (extra: Partial<Parameters<typeof TouchControls>[0]> = {}): HTMLDivElement =>
    renderControls({
      regime: 'surface',
      onFoot: onFoot.onFoot,
      onInteractPress: onFoot.onInteractPress,
      onInteractRelease: onFoot.onInteractRelease,
      onDrop: onFoot.onDrop,
      ...extra,
    });

  it('renders MOVE stick + RUN/JUMP/DROP/INTERACT on the surface while on foot', () => {
    renderOnFoot();
    expect(document.getElementById('touch-controls')).not.toBeNull();
    expect(document.getElementById('touch-stick-move')).not.toBeNull();
    expect(document.getElementById('touch-btn-run')?.textContent).toContain('RUN');
    expect(document.getElementById('touch-btn-jump')?.textContent).toContain('JUMP');
    expect(document.getElementById('touch-btn-drop')?.textContent).toContain('DROP');
    expect(document.getElementById('touch-btn-interact')?.textContent).toContain('INTERACT');
    // The flight sticks are NOT the on-foot layout (one MOVE stick only).
    expect(document.getElementById('touch-stick-left')).toBeNull();
    expect(document.getElementById('touch-stick-right')).toBeNull();
    expect(document.getElementById('touch-btn-fire')).toBeNull();
  });

  it('in-ship on the surface shows the flight sticks, NOT the on-foot layout (TASK-97)', () => {
    renderControls({ regime: 'surface' });
    expect(document.getElementById('touch-controls')).not.toBeNull();
    expect(document.getElementById('touch-stick-left')).not.toBeNull();
    expect(document.getElementById('touch-stick-right')).not.toBeNull();
    expect(document.getElementById('touch-stick-move')).toBeNull();
    expect(document.getElementById('touch-btn-jump')).toBeNull();
  });

  it('renders the flight layout in space even when onFoot is set (surface-only gate)', () => {
    renderOnFoot({ regime: 'space' });
    expect(document.getElementById('touch-stick-move')).toBeNull();
    expect(document.getElementById('touch-stick-left')).not.toBeNull();
  });

  it('MOVE stick: drag up = thrust +1, drag right = yaw +1, release = 0 (the on-foot keys)', () => {
    const c = renderOnFoot();
    const move = c.querySelector('[aria-label="move stick"]')!;
    pointer('pointerdown', 0, -64, move);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0 });
    pointer('pointermove', 64, 0, move);
    expect(source.snapshot()).toEqual({ thrust: 0, yaw: 1 });
    pointer('pointerup', 64, 0, move);
    expect(source.snapshot()).toEqual({ thrust: 0, yaw: 0 });
  });

  it('RUN: press = run true, release = run false (the Shift channel)', () => {
    const c = renderOnFoot();
    const run = c.querySelector('[aria-label="RUN"]')!;
    pointer('pointerdown', 0, 0, run);
    expect(source.snapshot()).toEqual({ run: true });
    pointer('pointerup', 0, 0, run);
    expect(source.snapshot()).toEqual({ run: false });
  });

  it('JUMP: press = jump true, release = jump false (the Space channel)', () => {
    const c = renderOnFoot();
    const jump = c.querySelector('[aria-label="JUMP"]')!;
    pointer('pointerdown', 0, 0, jump);
    expect(source.snapshot()).toEqual({ jump: true });
    pointer('pointerup', 0, 0, jump);
    expect(source.snapshot()).toEqual({ jump: false });
  });

  it('a held RUN survives a MOVE stick write (setChannel is partial)', () => {
    const c = renderOnFoot();
    const run = c.querySelector('[aria-label="RUN"]')!;
    const move = c.querySelector('[aria-label="move stick"]')!;
    pointer('pointerdown', 0, 0, run);
    pointer('pointerdown', 0, -64, move);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0, run: true });
  });

  it('DROP: one press = exactly one onDrop; release never drops a second unit', () => {
    const c = renderOnFoot();
    const drop = c.querySelector('[aria-label="DROP"]')!;
    pointer('pointerdown', 0, 0, drop);
    expect(onFoot.onDrop).toHaveBeenCalledTimes(1);
    pointer('pointerup', 0, 0, drop);
    expect(onFoot.onDrop).toHaveBeenCalledTimes(1);
    pointer('pointerdown', 0, 0, drop);
    pointer('pointerup', 0, 0, drop);
    expect(onFoot.onDrop).toHaveBeenCalledTimes(2);
  });

  it('INTERACT: press = onInteractPress (held accent), release = onInteractRelease', () => {
    const c = renderOnFoot();
    const interact = c.querySelector('[aria-label="INTERACT"]')!;
    pointer('pointerdown', 0, 0, interact);
    expect(onFoot.onInteractPress).toHaveBeenCalledTimes(1);
    expect(interact.getAttribute('aria-pressed')).toBe('true');
    // A long hold stays pressed until the release (the mining channel is open).
    pointer('pointerup', 0, 0, interact);
    expect(onFoot.onInteractRelease).toHaveBeenCalledTimes(1);
    expect(onFoot.onInteractPress).toHaveBeenCalledTimes(1);
    expect(interact.getAttribute('aria-pressed')).toBe('false');
  });

  it('a held INTERACT releases its channel when the on-foot layout unmounts', () => {
    const c = renderOnFoot();
    const interact = c.querySelector('[aria-label="INTERACT"]')!;
    pointer('pointerdown', 0, 0, interact);
    expect(onFoot.onInteractPress).toHaveBeenCalledTimes(1);
    // Re-entry: the regime leaves the surface — the unmounted button's
    // onRelease never fires, so the layout must end the channel itself.
    act(() => {
      roots[0].render(
        <TouchControls
          enabled
          regime="atmosphere"
          source={source}
          onFoot
          onInteractRelease={onFoot.onInteractRelease}
        />,
      );
    });
    expect(onFoot.onInteractRelease).toHaveBeenCalledTimes(1);
  });

  it('leaving the surface clears the on-foot channels (held thrust/run/jump)', () => {
    const c = renderOnFoot();
    const move = c.querySelector('[aria-label="move stick"]')!;
    const run = c.querySelector('[aria-label="RUN"]')!;
    const jump = c.querySelector('[aria-label="JUMP"]')!;
    pointer('pointerdown', 0, -64, move);
    pointer('pointerdown', 0, 0, run);
    pointer('pointerdown', 0, 0, jump);
    expect(source.snapshot()).toEqual({ thrust: 1, yaw: 0, run: true, jump: true });
    act(() => {
      roots[0].render(<TouchControls enabled regime="atmosphere" source={source} />);
    });
    expect(source.snapshot()).toEqual({});
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
  it('fire / fireHold / setWeapon / toggleTarget delegate; state is a live snapshot', async () => {
    // A fresh module instance (the combat binding is module state).
    vi.resetModules();
    const { installTouchDebug, bindTouchCombat } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    const calls: string[] = [];
    let snap: { weapon: WeaponId; locked: boolean } = { weapon: 'laser', locked: false };
    bindTouchCombat(state, () => ({
      fire: () => calls.push('fire'),
      // TASK-101: the functional-hold passthrough (the same loop as the button).
      fireHold: (on) => calls.push(on ? 'hold-on' : 'hold-off'),
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
    state.fireHold(true);
    state.fireHold(false);
    state.setWeapon('missile');
    state.toggleTarget();
    expect(calls).toEqual(['fire', 'hold-on', 'hold-off', 'set:missile', 'target']);
    // The snapshot is live: it tracks the bridge's state, not a copy.
    expect(state.state).toEqual({ weapon: 'missile', locked: true });
  });

  it('fireHold is a no-op before the combat bridge is bound (no crash)', async () => {
    vi.resetModules();
    const { installTouchDebug } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    expect(() => {
      state!.fireHold(true);
      state!.fireHold(false);
    }).not.toThrow();
  });

  it('fireHold stays a no-op when the bridge omits it (no crash)', async () => {
    vi.resetModules();
    const { installTouchDebug, bindTouchCombat } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    bindTouchCombat(state, () => ({
      fire: () => {},
      setWeapon: () => {},
      toggleTarget: () => {},
      snapshot: () => ({ weapon: 'laser', locked: false }),
    }));
    expect(() => {
      state!.fireHold(true);
    }).not.toThrow();
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

describe('touchDebug — the on-foot driver (TASK-93)', () => {
  it('move / run / jump delegate to the bound source (partial channels)', async () => {
    vi.resetModules();
    const { installTouchDebug, bindTouchDebug } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    const src = new TouchInputSource();
    bindTouchDebug(state, () => src);
    state.move({ thrust: 1 });
    state.move({ yaw: 0.5 }); // partial: thrust survives
    state.run(true);
    state.jump(true);
    expect(src.snapshot()).toEqual({ thrust: 1, yaw: 0.5, run: true, jump: true });
    state.move({ thrust: 0, yaw: 0 });
    state.run(false);
    state.jump(false);
    expect(src.snapshot()).toEqual({ thrust: 0, yaw: 0, run: false, jump: false });
  });

  it('interactPress / interactRelease / drop delegate to the bound bridge', async () => {
    vi.resetModules();
    const { installTouchDebug, bindTouchOnFoot } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    const calls: string[] = [];
    bindTouchOnFoot(state, () => ({
      interactPress: () => calls.push('press'),
      interactRelease: () => calls.push('release'),
      drop: () => calls.push('drop'),
    }));
    state.interactPress();
    state.interactPress();
    state.interactRelease();
    state.drop();
    expect(calls).toEqual(['press', 'press', 'release', 'drop']);
  });

  it('the on-foot passthroughs are no-ops before their bindings (no crash)', async () => {
    vi.resetModules();
    const { installTouchDebug } = await import('@client/touch-debug');
    const state = installTouchDebug()!;
    expect(() => {
      state!.move({ thrust: 1 });
      state!.run(true);
      state!.jump(true);
      state!.interactPress();
      state!.interactRelease();
      state!.drop();
    }).not.toThrow();
  });
});
