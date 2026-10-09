// @vitest-environment happy-dom
/**
 * TASK-90: TouchJoystick — pointer gestures → normalized {x, y}.
 *
 * Synthetic PointerEvents drive the component (no real pointer needed):
 * drag right → (1, 0), drag up → (0, 1) (UP-positive), a drag inside the
 * deadzone → {0, 0}, release/cancel → {0, 0} + knob reset, drags past the
 * rim clamp to the unit circle, and the control carries its aria-label.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetSettings } from '@client/a11y/reduced-motion';

import { joystickVector, TouchJoystick, type TouchVector } from './TouchJoystick';

const SIZE = 128;
const RADIUS = SIZE / 2;

let roots: Root[] = [];
let onChange: ReturnType<typeof vi.fn<(v: TouchVector) => void>>;

/** Mount a joystick; returns the base element (role="slider"). */
function renderJoystick(props: Partial<Parameters<typeof TouchJoystick>[0]> = {}): HTMLDivElement {
  onChange = vi.fn<(v: TouchVector) => void>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TouchJoystick label="flight stick" onChange={onChange} {...props} />);
  });
  roots.push(root);
  return container.querySelector<HTMLDivElement>('[role="slider"]')!;
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

function lastVector(): TouchVector {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  __resetSettings();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('joystickVector (pure)', () => {
  it('zero offset → {0, 0}', () => {
    expect(joystickVector(0, 0, RADIUS, 0.15)).toEqual({ x: 0, y: 0 });
  });

  it('deadzone suppresses small offsets (≤ deadzone × radius)', () => {
    expect(joystickVector(8, 0, RADIUS, 0.15)).toEqual({ x: 0, y: 0 }); // 8/64 = 0.125 < 0.15
    expect(joystickVector(9, 0, RADIUS, 0.15)).toEqual({ x: 0, y: 0 }); // 9/64 = 0.141 < 0.15
  });

  it('full radius → unit vector', () => {
    expect(joystickVector(RADIUS, 0, RADIUS, 0.15)).toEqual({ x: 1, y: 0 });
    expect(joystickVector(0, RADIUS, RADIUS, 0.15)).toEqual({ x: 0, y: 1 });
  });

  it('clamps drags past the rim to the unit circle', () => {
    const v = joystickVector(300, 300, RADIUS, 0.15);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 5);
    expect(v.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(v.y).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('honours a custom deadzone', () => {
    expect(joystickVector(20, 0, RADIUS, 0.4)).toEqual({ x: 0, y: 0 }); // 20 < 0.4×64
    expect(joystickVector(30, 0, RADIUS, 0.4).x).toBeCloseTo(30 / 64, 5);
  });
});

describe('TouchJoystick', () => {
  it('renders a named slider control (aria-label, range)', () => {
    const base = renderJoystick();
    expect(base.getAttribute('aria-label')).toBe('flight stick');
    expect(base.getAttribute('aria-valuemin')).toBe('-1');
    expect(base.getAttribute('aria-valuemax')).toBe('1');
    expect(base.getAttribute('aria-valuenow')).toBe('0');
  });

  it('a drag to the right edge emits x≈1, y≈0', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', RADIUS, 0, base);
    const v = lastVector();
    expect(v.x).toBeCloseTo(1, 5);
    expect(v.y).toBeCloseTo(0, 5);
  });

  it('a drag up emits y≈1 (up-positive)', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', 0, -RADIUS, base);
    const v = lastVector();
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.y).toBeCloseTo(1, 5);
  });

  it('a drag to the down-left rim emits the 45° unit vector (-√½, -√½)', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', -RADIUS, RADIUS, base);
    const v = lastVector();
    expect(v.x).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(v.y).toBeCloseTo(-Math.SQRT1_2, 5);
  });

  it('a tiny drag inside the deadzone emits {0, 0}', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', 5, 3, base); // mag 5.83 = 0.09r < 0.15r
    expect(lastVector()).toEqual({ x: 0, y: 0 });
  });

  it('drags that leave the element are clamped to the rim (capture keeps tracking)', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', 400, -400, base); // far outside the 128 px base
    const v = lastVector();
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 5);
    expect(v.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(v.y).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('release emits {0, 0} and resets the knob to centre', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', 60, 0, base);
    pointer('pointerup', 60, 0, base);
    expect(lastVector()).toEqual({ x: 0, y: 0 });
    expect(base.getAttribute('aria-valuenow')).toBe('0');
    const knob = base.querySelector<HTMLDivElement>('[aria-hidden="true"]')!;
    expect(knob.style.transform).toBe('translate(0px, 0px)');
  });

  it('pointercancel also resets to {0, 0}', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', 60, -40, base);
    pointer('pointercancel', 60, -40, base);
    expect(lastVector()).toEqual({ x: 0, y: 0 });
  });

  it('moves before a press are ignored (no active pointer)', () => {
    const base = renderJoystick();
    pointer('pointermove', 60, 0, base);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a disabled joystick is inert', () => {
    const base = renderJoystick({ disabled: true });
    expect(base.getAttribute('aria-disabled')).toBe('true');
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', RADIUS, 0, base);
    pointer('pointerup', RADIUS, 0, base);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the knob follows the drag (clamped inside the base)', () => {
    const base = renderJoystick();
    pointer('pointerdown', 0, 0, base);
    pointer('pointermove', 20, -15, base);
    const knob = base.querySelector<HTMLDivElement>('[aria-hidden="true"]')!;
    expect(knob.style.transform).toBe('translate(20px, -15px)');
    pointer('pointermove', 999, 0, base);
    // knob centre clamps to radius − knobRadius = 64 − 26.88
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(knob.style.transform)!;
    expect(parseFloat(m[1])).toBeCloseTo(RADIUS - (SIZE * 0.42) / 2, 5);
    expect(parseFloat(m[2])).toBeCloseTo(0, 5);
  });
});
