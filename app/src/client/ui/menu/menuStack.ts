/**
 * Menu stack — TASK-53 pure helpers.
 *
 * The ESC menu is a *stack* of transient surfaces (menu → ship →
 * settings …). The stack is the single source of truth for:
 *
 *   - which surface is on top (what to render),
 *   - whether game input must be suppressed (the stack is
 *     non-empty → the world is modal),
 *   - what `ESC` does (pop one level: panel → menu → closed).
 *
 * The menu never pauses the world — the server is unaware of it.
 * It only suppresses *local* input handling while a surface is
 * open.
 */

/** Every surface the ESC shell can show. */
export type MenuSurface = "menu" | "systems" | "ship" | "dock" | "settings";

/** All surface ids in display order (used by tests + the a11y pass). */
export const MENU_SURFACE_IDS: readonly MenuSurface[] = [
  "menu",
  "systems",
  "ship",
  "dock",
  "settings",
] as const;

/** The items rendered by the ESC menu panel. */
export type MenuItemId = "resume" | "systems" | "ships" | "settings";

/** Every menu item id in display order. */
export const MENU_ITEM_IDS: readonly MenuItemId[] = [
  "resume",
  "systems",
  "ships",
  "settings",
] as const;

/**
 * The keys a panel is allowed to handle while it owns the focus.
 * Every other key is swallowed by the menu shell's input gate —
 * even when the focused element sits inside the panel (a letter
 * typed into the menu must never reach the game).
 */
export const PANEL_ALLOWED_KEYS: readonly string[] = [
  "Tab",
  "Enter",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
];

/**
 * True when the key is one a panel may handle itself.
 */
export function isPanelAllowedKey(key: string): boolean {
  return PANEL_ALLOWED_KEYS.includes(key);
}

/**
 * The surface a menu item opens. `resume` closes the menu, so it
 * maps to `null`.
 */
export function surfaceForMenuItem(item: MenuItemId): MenuSurface | null {
  switch (item) {
    case "resume":
      return null;
    case "systems":
      return "systems";
    case "ships":
      return "ship";
    case "settings":
      return "settings";
  }
}

/**
 * Push a surface onto the stack. Re-pushing the surface that is
 * already on top is a no-op (the menu never grows a duplicate
 * layer when the player double-clicks an item).
 */
export function pushSurface(
  stack: readonly MenuSurface[],
  surface: MenuSurface,
): readonly MenuSurface[] {
  if (stack.length > 0 && stack[stack.length - 1] === surface) return stack;
  return [...stack, surface];
}

/** Pop the top surface. Returns the same array when empty. */
export function popSurface(stack: readonly MenuSurface[]): readonly MenuSurface[] {
  if (stack.length === 0) return stack;
  return stack.slice(0, stack.length - 1);
}

/** The surface currently on top, or `null` when the menu is closed. */
export function topSurface(stack: readonly MenuSurface[]): MenuSurface | null {
  if (stack.length === 0) return null;
  return stack[stack.length - 1] ?? null;
}

/** True when any surface is open (game input must be suppressed). */
export function isMenuOpen(stack: readonly MenuSurface[]): boolean {
  return stack.length > 0;
}

/**
 * True when the given surface is in the stack (used to decide which
 * overlay is mounted — e.g. the star chart is only open while
 * `systems` is on the stack).
 */
export function hasSurface(stack: readonly MenuSurface[], surface: MenuSurface): boolean {
  return stack.includes(surface);
}
