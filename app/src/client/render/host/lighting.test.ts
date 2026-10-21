/**
 * TASK-75 — scene lighting unit tests.
 *
 * The rig exists so `MeshStandardMaterial` meshes (own ship,
 * pooled remote entities) are not rendered pure black. These cases
 * pin the shape (3 lights, non-zero intensities) and the
 * dispose-by-iteration contract the RenderHost relies on.
 */
import { describe, expect, it } from "vitest";

import { disposeStarfield } from "./background.js";
import {
  AMBIENT_INTENSITY,
  FILL_INTENSITY,
  KEY_INTENSITY,
  createSceneLighting,
  lightingLightCount,
} from "./lighting.js";

describe("scene lighting", () => {
  it("mounts an ambient fill plus two directionals", () => {
    const group = createSceneLighting();
    expect(group.name).toBe("scene-lighting");
    expect(group.children.length).toBe(3);
    expect(lightingLightCount(group)).toBe(3);
  });

  it("keeps every intensity above zero so no face is pure black", () => {
    for (const intensity of [AMBIENT_INTENSITY, KEY_INTENSITY, FILL_INTENSITY]) {
      expect(intensity).toBeGreaterThan(0);
      expect(Number.isFinite(intensity)).toBe(true);
    }
  });

  it("is a no-op to 'dispose' — it owns no GPU buffers", () => {
    // RenderHost.dispose() runs every scene child through
    // disposeStarfield; the light group must survive that.
    expect(() => disposeStarfield(createSceneLighting())).not.toThrow();
  });
});
