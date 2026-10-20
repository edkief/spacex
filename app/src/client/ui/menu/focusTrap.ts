/**
 * Focus trap helpers — TASK-53.
 *
 * The menu shell is keyboard-first: `Tab` cycles inside the open
 * surface, `Enter` activates, arrows switch tabs, `ESC` backs out
 * one level. The helpers here are pure DOM utilities so they can
 * be unit-tested without a full React tree.
 */

/** Selector for the elements that can hold focus inside a panel. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Every focusable descendant of `root`, in DOM order. Hidden
 * elements (`display: none`) are skipped.
 *
 * TASK-54: the check is structural (`Element`, not `HTMLElement`)
 * because the star chart's focusable nodes are SVG `<g>` elements
 * — an `instanceof HTMLElement` test would silently drop them and
 * break the keyboard flow in the chart.
 */
export function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => isVisible(el));
}

/** True when the element is rendered (not `display: none`). */
function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.offsetParent !== null) return true;
  // SVG elements have no `offsetParent` — fall back to the client
  // rects (an empty rect list means the element is not rendered).
  const rects = (el as SVGElement).getClientRects?.();
  if (rects !== undefined) return rects.length > 0;
  return el === document.activeElement;
}

/**
 * Move focus to the next / previous focusable element, wrapping
 * around at both ends. Returns true when the event was handled
 * (so the caller can `preventDefault`).
 */
export function cycleFocus(root: HTMLElement | null, direction: 1 | -1): boolean {
  const items = focusableWithin(root);
  if (items.length === 0) return false;
  const active = document.activeElement;
  // TASK-54: structural check — the active element may be an SVG
  // `<g>` (a chart node), which is not an `HTMLElement`.
  const index = active instanceof Element ? items.indexOf(active as HTMLElement) : -1;
  let next: number;
  if (index === -1) {
    next = direction === 1 ? 0 : items.length - 1;
  } else {
    next = (index + direction + items.length) % items.length;
  }
  items[next]?.focus();
  return true;
}
