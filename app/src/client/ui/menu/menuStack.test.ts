/**
 * Menu stack — TASK-53 unit tests.
 *
 * Pure helpers: the stack push/pop rules, the top-surface lookup
 * and the menu-item → surface mapping.
 */
import { describe, expect, it } from "vitest";

import {
  hasSurface,
  isMenuOpen,
  MENU_ITEM_IDS,
  MENU_SURFACE_IDS,
  popSurface,
  pushSurface,
  surfaceForMenuItem,
  topSurface,
} from "./menuStack.js";

describe("menuStack (TASK-53)", () => {
  it("starts closed", () => {
    expect(isMenuOpen([])).toBe(false);
    expect(topSurface([])).toBeNull();
  });

  it("pushes a surface onto the stack", () => {
    const stack = pushSurface([], "menu");
    expect(stack).toEqual(["menu"]);
    expect(topSurface(stack)).toBe("menu");
    expect(isMenuOpen(stack)).toBe(true);
  });

  it("ignores a duplicate push of the top surface", () => {
    const stack = pushSurface(pushSurface([], "menu"), "menu");
    expect(stack).toHaveLength(1);
  });

  it("pops one level at a time", () => {
    const stack = pushSurface(pushSurface([], "menu"), "ship");
    expect(topSurface(stack)).toBe("ship");
    const popped = popSurface(stack);
    expect(popped).toEqual(["menu"]);
    expect(popSurface(popped)).toEqual([]);
  });

  it("keeps the stack unchanged when popping an empty stack", () => {
    const empty: readonly never[] = [];
    expect(popSurface(empty)).toBe(empty);
  });

  it("maps menu items to surfaces (resume closes the menu)", () => {
    expect(surfaceForMenuItem("resume")).toBeNull();
    expect(surfaceForMenuItem("systems")).toBe("systems");
    expect(surfaceForMenuItem("ships")).toBe("ship");
    expect(surfaceForMenuItem("settings")).toBe("settings");
  });

  it("exposes every surface + menu item id", () => {
    expect(MENU_SURFACE_IDS).toContain("menu");
    expect(MENU_SURFACE_IDS).toContain("systems");
    expect(MENU_SURFACE_IDS).toContain("ship");
    expect(MENU_SURFACE_IDS).toContain("settings");
    expect(MENU_ITEM_IDS).toEqual(["resume", "systems", "ships", "settings"]);
  });

  it("reports whether a surface is in the stack", () => {
    const stack = pushSurface(pushSurface([], "menu"), "systems");
    expect(hasSurface(stack, "systems")).toBe(true);
    expect(hasSurface(stack, "ship")).toBe(false);
  });
});
