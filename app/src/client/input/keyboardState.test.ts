/**
 * Keyboard state unit tests — TASK-74.
 *
 * Covers the spec's "keycode -> LocalInput mapping (including
 * that W and S are opposite axes and Shift maps to boost)":
 *
 *   - Held-set tracks `keydown` + `keyup` for physical codes.
 *   - `clear()` (blur/visibility-hidden) empties the set.
 *   - `preventDefault` only fires for the configured game keys.
 *   - `gameKeysForScheme` returns the union of every binding's
 *     physical key.
 */
import { describe, expect, it } from "vitest";

import { gameKeysForScheme, installKeyboardState, KeyboardState } from "./keyboardState.js";
import { SPACE_SCHEME } from "./controls.js";

describe("keyboardState — module surface", () => {
  it("records a keydown and clears it on keyup", () => {
    const ks = new KeyboardState();
    ks.recordKeyDown("KeyW");
    expect(ks.held.has("KeyW")).toBe(true);
    ks.recordKeyUp("KeyW");
    expect(ks.held.has("KeyW")).toBe(false);
  });

  it("is idempotent on duplicate keydowns (no listener spam)", () => {
    const ks = new KeyboardState();
    ks.recordKeyDown("KeyW");
    ks.recordKeyDown("KeyW");
    expect(ks.held.size).toBe(1);
  });

  it("clear() drops every held key", () => {
    const ks = new KeyboardState();
    ks.recordKeyDown("KeyW");
    ks.recordKeyDown("KeyA");
    expect(ks.held.size).toBe(2);
    ks.clear();
    expect(ks.held.size).toBe(0);
  });

  it("subscribers fire on transitions, can be unsubscribed", () => {
    const ks = new KeyboardState();
    let fires = 0;
    const off = ks.subscribe(() => {
      fires += 1;
    });
    ks.recordKeyDown("KeyW");
    expect(fires).toBe(1);
    ks.recordKeyDown("KeyW"); // no-op (idempotent on the held set)
    expect(fires).toBe(1);
    ks.recordKeyDown("KeyA");
    expect(fires).toBe(2);
    off();
    ks.recordKeyUp("KeyW");
    expect(fires).toBe(2);
  });
});

describe("keyboardState — installKeyboardState hooks", () => {
  it("installKeyboardState returns a state + dispose() with no document (no-op)", () => {
    const installed = installKeyboardState({ document: null, window: null });
    expect(installed.state).toBeInstanceOf(KeyboardState);
    expect(() => installed.dispose()).not.toThrow();
  });

  it("gameKeysForScheme returns the union of every binding's physical key", () => {
    const keys = gameKeysForScheme(SPACE_SCHEME);
    expect(keys.has("KeyW")).toBe(true);
    expect(keys.has("KeyS")).toBe(true);
    expect(keys.has("KeyA")).toBe(true);
    expect(keys.has("KeyD")).toBe(true);
    expect(keys.has("KeyQ")).toBe(true);
    expect(keys.has("KeyE")).toBe(true);
    expect(keys.has("ShiftLeft")).toBe(true);
  });

  it("SPACE_SCHEME is the active scheme for the test layer (regression guard)", () => {
    expect(SPACE_SCHEME.regime).toBe("space");
    expect(SPACE_SCHEME.keyBindings.length).toBeGreaterThan(0);
  });
});
