/**
 * Scene lighting — TASK-75.
 *
 * The render host shipped (TASK-73) with an unlit scene: the
 * starfield uses `PointsMaterial`, so nothing needed a light. Every
 * *solid* mesh the renderer has since grown — the own ship
 * (TASK-74) and the pooled remote entities (TASK-75) — uses
 * `MeshStandardMaterial`, which renders pure black without a light.
 *
 * This module owns the minimum rig that makes them readable in deep
 * space: one hemisphere fill (ambient, so nothing is ever pitch
 * black) plus one directional key light with a weak fill from the
 * opposite side. No shadows, no tone mapping, no post — a 16-player
 * system with 100+ remote meshes is already the frame budget story.
 *
 * All numbers are constants (no `Math.random` / `Date.now`).
 */
import { AmbientLight, DirectionalLight, Group } from "three";

/** Hemisphere-ish fill so unlit faces still read. */
export const AMBIENT_INTENSITY = 0.55;
/** Key light intensity (the dominant highlight). */
export const KEY_INTENSITY = 1.6;
/** Opposing fill so a ship's dark side is not a silhouette. */
export const FILL_INTENSITY = 0.45;

/**
 * Build the scene's light rig as a single `Group`. Lights are
 * collected from anywhere in the scene graph, so callers can mount
 * the group wherever they like (the render host mounts it on the
 * scene root).
 */
export function createSceneLighting(): Group {
  const group = new Group();
  group.name = "scene-lighting";

  const ambient = new AmbientLight(0x8899bb, AMBIENT_INTENSITY);
  ambient.name = "ambient";
  group.add(ambient);

  const key = new DirectionalLight(0xffffff, KEY_INTENSITY);
  key.name = "key";
  key.position.set(4, 6, 3);
  group.add(key);

  const fill = new DirectionalLight(0x88aaff, FILL_INTENSITY);
  fill.name = "fill";
  fill.position.set(-5, -2, -4);
  group.add(fill);

  return group;
}

/** Number of lights in the rig (unit-test seam). */
export function lightingLightCount(group: Group): number {
  let n = 0;
  group.traverse((node) => {
    const type = (node as { isLight?: boolean }).isLight === true;
    if (type) n += 1;
  });
  return n;
}
