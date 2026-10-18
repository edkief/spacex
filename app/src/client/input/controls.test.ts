/**
 * Controls remap tests — TASK-25 step 3.
 *
 * Covers the spec checklist:
 *
 *   - ControlScheme per regime (space / atmosphere / surface).
 *   - Controls.applyRegime swaps schemes at the boundary frame.
 *   - Same scheme keyBindings across client/server (deterministic).
 *   - Listener fires on transition, is idempotent on no-op.
 *   - 500 ms divergence rule (snap to server after timeout).
 */

import { describe, expect, it, vi } from "vitest";

import {
  ATMOSPHERE_SCHEME,
  CHARACTER_SCHEME,
  Controls,
  SCHEME_BY_REGIME,
  SPACE_SCHEME,
  SURFACE_SCHEME,
  debugRegimeDivergenceMessage,
  shouldSnapToServer,
} from "./controls.js";
import type { Regime } from "@shared/regime.js";

describe("controls: scheme table", () => {
  it("every regime maps to a known scheme", () => {
    expect(SCHEME_BY_REGIME.space).toBe(SPACE_SCHEME);
    expect(SCHEME_BY_REGIME.atmosphere).toBe(ATMOSPHERE_SCHEME);
    expect(SCHEME_BY_REGIME.surface).toBe(SURFACE_SCHEME);
  });

  it("each scheme reports the regime it represents", () => {
    expect(SPACE_SCHEME.regime).toBe("space");
    expect(ATMOSPHERE_SCHEME.regime).toBe("atmosphere");
    expect(SURFACE_SCHEME.regime).toBe("surface");
  });

  it("space scheme has no VTOL `up` binding", () => {
    const ups = SPACE_SCHEME.keyBindings.filter((b) => b.action === "up");
    expect(ups.length).toBe(0);
  });

  it("atmosphere scheme has a VTOL `up` binding", () => {
    const ups = ATMOSPHERE_SCHEME.keyBindings.filter((b) => b.action === "up");
    expect(ups.length).toBe(1);
    expect(ups[0]?.key).toBe("Space");
  });

  it("surface scheme has both VTOL `up` and an `interact` binding (stub for TASK-33)", () => {
    const ups = SURFACE_SCHEME.keyBindings.filter((b) => b.action === "up");
    const interacts = SURFACE_SCHEME.keyBindings.filter((b) => b.action === "interact");
    expect(ups.length).toBe(1);
    expect(interacts.length).toBe(1);
  });
});

describe("controls: scheme key stability (determinism)", () => {
  it("space scheme keyBindings are bit-equal across two reads", () => {
    const a = [...SPACE_SCHEME.keyBindings];
    const b = [...SPACE_SCHEME.keyBindings];
    expect(a).toEqual(b);
  });

  it("atmosphere scheme keyBindings are bit-equal across two reads", () => {
    const a = [...ATMOSPHERE_SCHEME.keyBindings];
    const b = [...ATMOSPHERE_SCHEME.keyBindings];
    expect(a).toEqual(b);
  });

  it("space and atmosphere differ only in the `up` binding", () => {
    // Both schemes share the flight axes; atmosphere adds `up`.
    const spaceActions = new Set(SPACE_SCHEME.keyBindings.map((b) => b.action));
    const atmoActions = new Set(ATMOSPHERE_SCHEME.keyBindings.map((b) => b.action));
    for (const a of spaceActions) {
      expect(atmoActions.has(a)).toBe(true);
    }
    // Atmosphere has one more action than space.
    expect(atmoActions.size).toBe(spaceActions.size + 1);
    expect(atmoActions.has("up")).toBe(true);
  });
});

describe("controls: Controls store", () => {
  it("starts in the regime passed to the constructor", () => {
    const c = new Controls("atmosphere");
    expect(c.regime()).toBe("atmosphere");
    expect(c.scheme().id).toBe("ship-atmosphere");
  });

  it("defaults to 'space' when constructed without an argument", () => {
    const c = new Controls();
    expect(c.regime()).toBe("space");
    expect(c.scheme().id).toBe("ship-space");
  });

  it("applyRegime returns true on transition, false on no-op", () => {
    const c = new Controls("space");
    expect(c.applyRegime("atmosphere")).toBe(true);
    expect(c.applyRegime("atmosphere")).toBe(false);
    expect(c.applyRegime("surface")).toBe(true);
    expect(c.applyRegime("space")).toBe(true);
    expect(c.applyRegime("space")).toBe(false);
  });

  it("applyRegime swaps the scheme at the boundary frame", () => {
    const c = new Controls("space");
    expect(c.scheme().id).toBe("ship-space");
    c.applyRegime("atmosphere");
    expect(c.scheme().id).toBe("ship-atmosphere");
    c.applyRegime("surface");
    expect(c.scheme().id).toBe("ship-surface");
    c.applyRegime("space");
    expect(c.scheme().id).toBe("ship-space");
  });

  it("does not fire the listener on a no-op applyRegime", () => {
    const c = new Controls("space");
    const listener = vi.fn();
    c.onRegimeChange(listener);
    c.applyRegime("space"); // no-op
    expect(listener).not.toHaveBeenCalled();
  });

  it("fires the listener with the right transition shape", () => {
    const c = new Controls("space");
    const listener = vi.fn();
    c.onRegimeChange(listener);
    c.applyRegime("atmosphere");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      from: "space",
      to: "atmosphere",
      schemeId: "ship-atmosphere",
    });
  });

  it("subscribes multiple listeners and fires all on transition", () => {
    const c = new Controls("space");
    const a = vi.fn();
    const b = vi.fn();
    c.onRegimeChange(a);
    c.onRegimeChange(b);
    c.applyRegime("atmosphere");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("the returned unsubscribe function actually unsubscribes", () => {
    const c = new Controls("space");
    const listener = vi.fn();
    const off = c.onRegimeChange(listener);
    off();
    c.applyRegime("atmosphere");
    expect(listener).not.toHaveBeenCalled();
  });

  it("swallows listener exceptions (one buggy subscriber doesn't kill the rest)", () => {
    const c = new Controls("space");
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    c.onRegimeChange(a);
    c.onRegimeChange(b);
    // Should not throw despite `a` blowing up.
    expect(() => c.applyRegime("atmosphere")).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("the full space → atmosphere → surface → atmosphere → space cycle works", () => {
    const c = new Controls("space");
    const seen: Regime[] = [];
    c.onRegimeChange((e) => {
      seen.push(e.to);
    });
    const path: Regime[] = ["atmosphere", "surface", "atmosphere", "space"];
    for (const next of path) {
      c.applyRegime(next);
    }
    expect(seen).toEqual(path);
  });

  it("two Controls instances do not share state", () => {
    const a = new Controls("space");
    const b = new Controls("atmosphere");
    a.applyRegime("surface");
    expect(a.regime()).toBe("surface");
    expect(b.regime()).toBe("atmosphere");
  });
});

describe("controls: divergence tolerance (TASK-25 AC #4)", () => {
  it("does not snap when server and client agree", () => {
    expect(
      shouldSnapToServer({
        serverRegime: "atmosphere",
        predictedRegime: "atmosphere",
        divergenceMs: 10_000,
      }),
    ).toBe(false);
  });

  it("does not snap when divergence is short (< threshold)", () => {
    expect(
      shouldSnapToServer({
        serverRegime: "atmosphere",
        predictedRegime: "space",
        divergenceMs: 250, // < 500 ms default
      }),
    ).toBe(false);
  });

  it("snaps when divergence exceeds the threshold (default 500 ms)", () => {
    expect(
      shouldSnapToServer({
        serverRegime: "atmosphere",
        predictedRegime: "space",
        divergenceMs: 600,
      }),
    ).toBe(true);
  });

  it("honors a custom divergence threshold", () => {
    expect(
      shouldSnapToServer(
        {
          serverRegime: "surface",
          predictedRegime: "atmosphere",
          divergenceMs: 300,
        },
        200,
      ),
    ).toBe(true);
  });

  it("debug message includes both regimes and the divergence duration", () => {
    const msg = debugRegimeDivergenceMessage({
      entityId: "entity:ship-1",
      serverRegime: "atmosphere",
      predictedRegime: "space",
      divergenceMs: 750,
    });
    expect(msg).toContain("entity:ship-1");
    expect(msg).toContain("server=atmosphere");
    expect(msg).toContain("client=space");
    expect(msg).toContain("750 ms");
  });
});

// ---------------------------------------------------------------------------
// TASK-31: character-mode scheme + on-foot toggle
// ---------------------------------------------------------------------------

describe("controls: character scheme + setOnFoot (TASK-31)", () => {
  it("the character scheme is registered in the ControlSchemeId union", () => {
    expect(CHARACTER_SCHEME).toBeDefined();
    expect(CHARACTER_SCHEME.id).toBe("character");
  });

  it("CHARACTER_SCHEME carries an `interact` binding for the future walk/look (TASK-32)", () => {
    const interacts = CHARACTER_SCHEME.keyBindings.filter((b) => b.action === "interact");
    expect(interacts.length).toBe(1);
    expect(interacts[0]?.key).toBe("KeyE");
  });

  it("setOnFoot(true) swaps the active scheme to CHARACTER_SCHEME", () => {
    const controls = new Controls("surface");
    expect(controls.scheme().id).toBe("ship-surface");
    const changed = controls.setOnFoot(true);
    expect(changed).toBe(true);
    expect(controls.scheme().id).toBe("character");
    expect(controls.isOnFoot()).toBe(true);
  });

  it("setOnFoot(false) returns to the regime-mapped scheme", () => {
    const controls = new Controls("surface");
    controls.setOnFoot(true);
    expect(controls.scheme().id).toBe("character");
    controls.setOnFoot(false);
    expect(controls.scheme().id).toBe("ship-surface");
    expect(controls.isOnFoot()).toBe(false);
  });

  it("setOnFoot is a no-op when the state already matches", () => {
    const controls = new Controls("surface");
    controls.setOnFoot(true);
    const changed = controls.setOnFoot(true);
    expect(changed).toBe(false);
  });

  it("regime changes while on-foot keep CHARACTER_SCHEME active", () => {
    // Sanity: a disembarked character should stay in character
    // mode even if the server's reported regime flips (e.g. walk
    // off the surface edge into atmosphere). The on-foot flag is
    // orthogonal to the regime — TASK-35 (re-entry) clears it.
    const controls = new Controls("surface");
    controls.setOnFoot(true);
    expect(controls.scheme().id).toBe("character");
    controls.applyRegime("atmosphere");
    expect(controls.scheme().id).toBe("character");
    expect(controls.isOnFoot()).toBe(true);
  });
});
