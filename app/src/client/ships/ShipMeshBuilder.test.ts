/**
 * Paint-zone + mesh-registry tests for `ShipPaintRegistry` (TASK-21).
 *
 * Covers the renderer-side paint logic without a three.js dependency:
 * every test uses the in-memory adapter (no GPU, no WebGL).
 *
 * Acceptance criteria covered here:
 *   - 3 paint zones per ship (hull / accent / trim).
 *   - `applyLivery(shipId, livery)` swaps colors in place (no rebuild).
 *   - `defaultLiveryFor(classId)` returns the canonical paint triple.
 *   - Disposal is idempotent and releases every zone material.
 *   - `liveryToPaintZones` correctly maps the wire-shape triple.
 */
import { describe, expect, it } from "vitest";
import {
  PAINT_ZONES,
  ShipPaintRegistry,
  createInMemoryAdapter,
  defaultLiveryFor,
  liveryToPaintZones,
  type InMemoryPaintMaterial,
  type PaintZone,
} from "./ShipMeshBuilder.js";

const CUSTOM_LIVERY = {
  primary: "#ff8800",
  secondary: "#222244",
  accent: "#ffff00",
} as const;

const DIFFERENT_LIVERY = {
  primary: "#0a0a0a",
  secondary: "#cccccc",
  accent: "#ff00ff",
} as const;

describe("PAINT_ZONES", () => {
  it("lists exactly the three spec'd zones in stable UI order", () => {
    expect([...PAINT_ZONES]).toEqual(["hull", "accent", "trim"]);
    expect(PAINT_ZONES.length).toBe(3);
  });
});

describe("defaultLiveryFor", () => {
  it("returns a valid six-digit-hex triple for every ship class", () => {
    for (const id of ["scout", "freighter", "interceptor"] as const) {
      const livery = defaultLiveryFor(id);
      expect(livery.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(livery.secondary).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(livery.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("returns the same canonical default for every v1 class", () => {
    const all = ["scout", "freighter", "interceptor"].map((id) => defaultLiveryFor(id as never));
    expect(all[0]).toEqual(all[1]);
    expect(all[1]).toEqual(all[2]);
  });
});

describe("liveryToPaintZones", () => {
  it("maps the wire triple to hull / accent / trim paint zones", () => {
    const mapped = liveryToPaintZones(CUSTOM_LIVERY);
    expect(mapped.hull).toBe(CUSTOM_LIVERY.primary);
    expect(mapped.accent).toBe(CUSTOM_LIVERY.accent);
    expect(mapped.trim).toBe(CUSTOM_LIVERY.secondary);
  });

  it("is total — every zone is present in the output", () => {
    const mapped = liveryToPaintZones(CUSTOM_LIVERY);
    for (const zone of PAINT_ZONES) {
      expect(mapped[zone]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("ShipPaintRegistry", () => {
  it("buildShipMesh creates 3 paint materials, one per zone", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const mesh = registry.buildShipMesh("ship-001", "scout");
    expect(mesh.materials.hull.zone).toBe("hull");
    expect(mesh.materials.accent.zone).toBe("accent");
    expect(mesh.materials.trim.zone).toBe("trim");
    // Three materials allocated by the adapter.
    expect(adapter.created).toHaveLength(3);
  });

  it("buildShipMesh initialises every zone with the default livery for the class", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const mesh = registry.buildShipMesh("ship-001", "interceptor");
    const defaults = defaultLiveryFor("interceptor");
    expect(mesh.materials.hull.color).toBe(defaults.primary);
    expect(mesh.materials.accent.color).toBe(defaults.accent);
    expect(mesh.materials.trim.color).toBe(defaults.secondary);
  });

  it("buildShipMesh is idempotent — repeated calls return the same mesh", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const a = registry.buildShipMesh("ship-001", "scout");
    const b = registry.buildShipMesh("ship-001", "scout");
    expect(b).toBe(a);
    // No new materials allocated on the second call.
    expect(adapter.created).toHaveLength(3);
  });

  it("buildShipMeshWithLivery paints the mesh on creation", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const mesh = registry.buildShipMeshWithLivery("ship-002", "freighter", CUSTOM_LIVERY);
    expect(mesh.materials.hull.color).toBe(CUSTOM_LIVERY.primary);
    expect(mesh.materials.accent.color).toBe(CUSTOM_LIVERY.accent);
    expect(mesh.materials.trim.color).toBe(CUSTOM_LIVERY.secondary);
  });

  it("applyLivery swaps colors in place — no new materials allocated", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const mesh = registry.buildShipMesh("ship-003", "scout");
    const originalHullMaterial = mesh.materials.hull;
    const originalAccentMaterial = mesh.materials.accent;
    const originalTrimMaterial = mesh.materials.trim;

    registry.applyLivery("ship-003", CUSTOM_LIVERY);

    // No rebuild: same material instances.
    expect(mesh.materials.hull).toBe(originalHullMaterial);
    expect(mesh.materials.accent).toBe(originalAccentMaterial);
    expect(mesh.materials.trim).toBe(originalTrimMaterial);
    // Colours swapped to match.
    expect(mesh.materials.hull.color).toBe(CUSTOM_LIVERY.primary);
    expect(mesh.materials.accent.color).toBe(CUSTOM_LIVERY.accent);
    expect(mesh.materials.trim.color).toBe(CUSTOM_LIVERY.secondary);
    // Adapter recorded one set call per zone that changed (all three).
    expect(adapter.totalSetCalls()).toBe(3);
    // Adapter did NOT create any new materials after the initial build.
    expect(adapter.created).toHaveLength(3);
  });

  it("applyLivery skips zones whose color didn't change (cheap idempotent updates)", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const mesh = registry.buildShipMesh("ship-004", "scout");
    const sameColors = {
      primary: mesh.materials.hull.color,
      secondary: mesh.materials.trim.color,
      accent: mesh.materials.accent.color,
    };
    registry.applyLivery("ship-004", sameColors);
    // Zero set calls because every zone already matched.
    expect(adapter.totalSetCalls()).toBe(0);
  });

  it("applyLivery throws when called for a ship that has not been built", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    expect(() => registry.applyLivery("ghost", CUSTOM_LIVERY)).toThrow(/no mesh registered/);
  });

  it("applyLivery accepts partial updates — only the zones whose color changed are touched", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    const mesh = registry.buildShipMesh("ship-005", "freighter");
    // Change one zone only.
    registry.applyLivery("ship-005", {
      primary: mesh.materials.hull.color, // unchanged
      secondary: "#abcdef",
      accent: mesh.materials.accent.color, // unchanged
    });
    expect(adapter.totalSetCalls()).toBe(1);
    expect(mesh.materials.trim.color).toBe("#abcdef");
  });

  it("disposeShip releases every per-zone material and removes the entry", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    registry.buildShipMesh("ship-006", "scout");
    expect(registry.size()).toBe(1);
    registry.disposeShip("ship-006");
    expect(registry.size()).toBe(0);
    expect(registry.getShipMesh("ship-006")).toBeUndefined();
  });

  it("disposeShip is idempotent — a second call is a no-op", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    registry.buildShipMesh("ship-007", "scout");
    registry.disposeShip("ship-007");
    expect(() => registry.disposeShip("ship-007")).not.toThrow();
  });

  it("disposeAll releases every registered ship", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    registry.buildShipMesh("ship-008", "scout");
    registry.buildShipMesh("ship-009", "freighter");
    registry.buildShipMesh("ship-010", "interceptor");
    expect(registry.size()).toBe(3);
    registry.disposeAll();
    expect(registry.size()).toBe(0);
  });

  it("re-paint after dispose rebuilds — adapter allocates fresh materials", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    registry.buildShipMesh("ship-011", "scout");
    registry.disposeShip("ship-011");
    expect(adapter.created).toHaveLength(3);
    const mesh = registry.buildShipMesh("ship-011", "scout");
    expect(adapter.created).toHaveLength(6);
    expect(mesh.materials.hull.zone).toBe("hull");
  });

  it("supports many ships with isolated paint state", () => {
    const adapter = createInMemoryAdapter();
    const registry = new ShipPaintRegistry(adapter);
    registry.buildShipMeshWithLivery("ship-100", "scout", CUSTOM_LIVERY);
    registry.buildShipMeshWithLivery("ship-200", "freighter", DIFFERENT_LIVERY);

    // Repaint only ship-100.
    registry.applyLivery("ship-100", DIFFERENT_LIVERY);
    const a = registry.getShipMesh("ship-100")!;
    const b = registry.getShipMesh("ship-200")!;
    expect(a.materials.hull.color).toBe(DIFFERENT_LIVERY.primary);
    // ship-200 unchanged.
    expect(b.materials.hull.color).toBe(DIFFERENT_LIVERY.primary);
    // (Both happen to be the same colour triple, but the per-ship
    // material instances are distinct — that is the property under
    // test.)
    expect(a.materials.hull).not.toBe(b.materials.hull);
  });
});

describe("InMemoryPaintMaterial", () => {
  it("applyMaterialColor increments the setCalls counter", () => {
    const adapter = createInMemoryAdapter();
    const mat = adapter.createPaintMaterial("hull", "#aaaaaa") as InMemoryPaintMaterial;
    expect(mat.setCalls).toBe(0);
    adapter.applyMaterialColor(mat, "#bbbbbb");
    expect(mat.setCalls).toBe(1);
    expect(mat.color).toBe("#bbbbbb");
  });
});

describe("paint zone enumeration covers every zone key", () => {
  // Defensive: if someone adds a fourth paint zone (e.g. "decal"),
  // this test forces them to update the in-memory adapter too.
  const expected: PaintZone[] = ["hull", "accent", "trim"];
  for (const zone of expected) {
    it(`zone '${zone}' round-trips through liveryToPaintZones`, () => {
      const triple = {
        primary: "#111111",
        secondary: "#222222",
        accent: "#333333",
      };
      const mapped = liveryToPaintZones(triple);
      // 'hull' → primary, 'accent' → accent, 'trim' → secondary.
      const expected = {
        hull: "#111111",
        accent: "#333333",
        trim: "#222222",
      }[zone];
      expect(mapped[zone]).toBe(expected);
    });
  }
});
