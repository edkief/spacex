// @vitest-environment happy-dom
/**
 * TASK-90: TouchButton — pointer down/up → press/release.
 *
 * Synthetic PointerEvents: pointerdown fires onPress once, pointerup /
 * pointercancel fire onRelease (a long hold stays pressed until release),
 * a disabled button is inert, the ≥ 44 px hit target is enforced even for
 * small visuals, and the a11y attributes (aria-label, aria-pressed when
 * controlled) are present.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TouchButton, type TouchButtonProps } from './TouchButton';

type VoidFn = ReturnType<typeof vi.fn<() => void>>;

let roots: Root[] = [];
let onPress: VoidFn;
let onRelease: VoidFn;

/** Mount a button; returns the hit wrapper (role="button"). */
function renderButton(props: Partial<TouchButtonProps> = {}): HTMLDivElement {
  onPress = vi.fn<() => void>();
  onRelease = vi.fn<() => void>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TouchButton label="Fire" onPress={onPress} onRelease={onRelease} {...props} />);
  });
  roots.push(root);
  return container.querySelector<HTMLDivElement>('[role="button"]')!;
}

/** Dispatch a synthetic PointerEvent (happy-dom implements PointerEvent). */
function pointer(type: string, target: Element): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
        pointerId: 1,
        isPrimary: true,
      }),
    );
  });
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('TouchButton', () => {
  it('pointerdown calls onPress once, pointerup calls onRelease', () => {
    const btn = renderButton();
    pointer('pointerdown', btn);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
    pointer('pointerup', btn);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('a long hold keeps pressed until release (moves fire nothing)', () => {
    const btn = renderButton();
    pointer('pointerdown', btn);
    pointer('pointermove', btn);
    pointer('pointermove', btn);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
    pointer('pointerup', btn);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('pointercancel releases a held button', () => {
    const btn = renderButton();
    pointer('pointerdown', btn);
    pointer('pointercancel', btn);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('a stray pointerup (no prior down) fires nothing', () => {
    const btn = renderButton();
    pointer('pointerup', btn);
    expect(onPress).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('a disabled button is inert', () => {
    const btn = renderButton({ disabled: true });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    pointer('pointerdown', btn);
    pointer('pointerup', btn);
    expect(onPress).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('exposes aria-label and the visible label text', () => {
    const btn = renderButton({ label: 'Boost' });
    expect(btn.getAttribute('aria-label')).toBe('Boost');
    expect(btn.textContent).toContain('Boost');
  });

  it('exposes aria-pressed only when controlled', () => {
    expect(renderButton().hasAttribute('aria-pressed')).toBe(false);
    expect(renderButton({ pressed: true }).getAttribute('aria-pressed')).toBe('true');
    expect(renderButton({ pressed: false }).getAttribute('aria-pressed')).toBe('false');
  });

  it('enforces the ≥ 44 px hit target for small visuals', () => {
    const btn = renderButton({ size: 32 });
    expect(btn.style.width).toBe('44px');
    expect(btn.style.height).toBe('44px');
    const face = btn.querySelector<HTMLDivElement>('[aria-hidden="true"]')!;
    expect(face.style.width).toBe('32px');
    expect(face.style.height).toBe('32px');
  });

  it('uses the visual size for large buttons (hit = visual)', () => {
    const btn = renderButton({ size: 80 });
    expect(btn.style.width).toBe('80px');
  });

  it('renders an icon alongside the label', () => {
    const btn = renderButton({ icon: <span data-testid="icon">✚</span> });
    expect(btn.querySelector('[data-testid="icon"]')).not.toBeNull();
  });
});
