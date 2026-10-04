/**
 * Minimal focus trap for the TASK-53 modal surfaces (ESC menu + shared
 * panel). While `active`:
 * - focus moves INTO the surface on activation (first focusable element),
 * - Tab / Shift+Tab wrap inside it (never escape to the game UI behind),
 * - on deactivation the previously-focused element is restored.
 *
 * TASK-54 builds the full a11y pass on top of this (the spec's boundary);
 * this is just enough to keep the keyboard loop contained.
 */

import React from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
): void {
  React.useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? idx <= 0
          ? items.length - 1
          : idx - 1
        : idx === -1 || idx === items.length - 1
          ? 0
          : idx + 1;
      items[next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [ref, active]);
}
