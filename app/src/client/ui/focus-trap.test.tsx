// @vitest-environment happy-dom
/**
 * TASK-53: the focus trap for the modal surfaces — on activation focus
 * moves INTO the surface (first focusable), Tab / Shift+Tab wrap inside
 * it (they never escape to the game UI behind), and on deactivation the
 * previously-focused element is restored (the AC's "restored on close").
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useFocusTrap } from './focus-trap';

let roots: Root[] = [];

function renderTrap(active: boolean): HTMLDivElement {
  const Harness: React.FC = () => {
    const ref = React.useRef<HTMLDivElement>(null);
    useFocusTrap(ref, active);
    return (
      <div ref={ref}>
        {['a', 'b', 'c'].map((b) => (
          <button key={b} id={`btn-${b}`} type="button">
            {b}
          </button>
        ))}
      </div>
    );
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
  roots.push(root);
  return container;
}

/** A window-level keydown (the trap listens on window). */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
};

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('useFocusTrap (TASK-53)', () => {
  it('moves focus INTO the surface on activation (first focusable)', () => {
    renderTrap(true);
    expect(document.activeElement?.id).toBe('btn-a');
  });

  it('does nothing while inactive', () => {
    renderTrap(false);
    expect(document.activeElement?.id).not.toBe('btn-a');
  });

  it('Tab wraps from the LAST focusable back to the first; Shift+Tab the other way', () => {
    renderTrap(true);
    act(() => {
      document.querySelector<HTMLButtonElement>('#btn-c')?.focus();
    });
    press('Tab');
    expect(document.activeElement?.id).toBe('btn-a'); // c → a (wrapped)
    press('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('btn-c'); // a → c (wrapped backwards)
  });

  it('Tab steps forward through the middle without wrapping', () => {
    renderTrap(true);
    press('Tab');
    expect(document.activeElement?.id).toBe('btn-b');
    press('Tab');
    expect(document.activeElement?.id).toBe('btn-c');
  });

  it('restores the PREVIOUSLY-focused element on deactivation', () => {
    // The user was in the chat input; a surface opens (the trap takes over),
    // the user tabs around; the surface closes → chat focus comes back.
    const prev = document.createElement('button');
    prev.id = 'chat';
    document.body.appendChild(prev);
    act(() => {
      prev.focus();
    });
    const el = renderTrap(true); // captures #chat as the previous focus
    expect(document.activeElement?.id).toBe('btn-a');
    act(() => {
      el.querySelector<HTMLButtonElement>('#btn-c')?.focus();
    });
    for (const root of roots) act(() => root.unmount()); // surface closes
    roots = [];
    expect(document.activeElement?.id).toBe('chat'); // restored
  });
});
