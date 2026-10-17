/**
 * three.js adapter for `ShipPaintRegistry` (TASK-21).
 *
 * Runtime glue: when the renderer boots, it imports three.js,
 * constructs a `MaterialAdapter` from the three.js material class
 * it wants (typically `MeshStandardMaterial` for full-LOD ships,
 * `MeshBasicMaterial` for impostors), and passes that adapter into
 * `ShipPaintRegistry`. The builder never touches three.js directly.
 *
 * Why not a class-based adapter?
 *   - three.js constructors are factory functions, not ES classes
 *     we can subclass cleanly across versions. The closures in
 *     `createThreeMaterialAdapter()` keep the surface tight while
 *     still letting the renderer pick the material class.
 *
 * Why import three.js lazily?
 *   - `ShipMeshBuilder` (the paint-zone logic) is unit-tested under
 *     Node without three.js. Keeping the three.js import inside this
 *     file — which is loaded only by the client runtime — keeps the
 *     shared/client split clean and lets vitest run `ShipMeshBuilder`
 *     tests in a happy-dom environment without three.js noise.
 */
import { Color, type Material } from "three";
import type { MaterialAdapter, PaintMaterial, PaintZone } from "./ShipMeshBuilder.js";

/**
 * Minimal shape of a three.js material that supports `color` mutation.
 *
 * Both `MeshBasicMaterial` and `MeshStandardMaterial` (and every
 * common subclass) satisfy this — they expose a `THREE.Color`
 * instance under `.color`. The adapter mutates that instance
 * directly so a paint update does not allocate a new material.
 */
interface ThreeColorMaterial extends Material {
  color: Color;
}

/**
 * Adapter implementation backed by a real three.js material class.
 *
 * @param MaterialClass — the constructor the adapter will call for
 *                        each paint zone (e.g. `MeshBasicMaterial`,
 *                        `MeshStandardMaterial`).
 *
 * The adapter wraps each created material in a thin `PaintMaterial`
 * facade so the rest of the renderer code never sees a three.js
 * concrete type.
 */
export function createThreeMaterialAdapter(
  MaterialClass: new (params: { color: number }) => ThreeColorMaterial,
): MaterialAdapter {
  return {
    createPaintMaterial(zone: PaintZone, hex: string): PaintMaterial {
      const colour = new Color(hex);
      const material = new MaterialClass({ color: colour.getHex() });
      return wrapThreeMaterial(zone, material, hex);
    },
    applyMaterialColor(material: PaintMaterial, hex: string): void {
      // three.js stores the colour in a `Color` instance under `.color`.
      // Mutating in place means zero allocation per paint — the hot path
      // stays within the frame budget.
      const inner = material as PaintMaterial & { __inner?: ThreeColorMaterial };
      if (inner.__inner === undefined) {
        throw new Error(`applyMaterialColor: material was not created by the three.js adapter`);
      }
      inner.__inner.color.set(hex);
      material.color = hex;
    },
    disposeMaterial(material: PaintMaterial): void {
      const inner = material as PaintMaterial & { __inner?: ThreeColorMaterial };
      if (inner.__inner !== undefined) {
        inner.__inner.dispose();
        inner.__inner = undefined;
      }
    },
  };
}

/**
 * Wrap a raw three.js material in the `PaintMaterial` facade the
 * builder expects. The original is stashed on `__inner` so the
 * adapter can reach back into it for in-place colour mutation and
 * disposal. External callers should never touch `__inner`.
 */
function wrapThreeMaterial(zone: PaintZone, inner: ThreeColorMaterial, hex: string): PaintMaterial {
  const facade: PaintMaterial & { __inner?: ThreeColorMaterial } = {
    zone,
    color: hex,
    dispose(): void {
      if (facade.__inner !== undefined) {
        facade.__inner.dispose();
        facade.__inner = undefined;
      }
    },
  };
  facade.__inner = inner;
  return facade;
}
