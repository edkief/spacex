/**
 * Background starfield — ported to three.js for TASK-73.
 *
 * The TASK-70 raw-WebGL starfield drew 800 deterministically-placed
 * points into a 2D canvas; this module keeps the **same star
 * generator** (LCG RNG, 800 points, 90/10 bright/dim split, seed
 * `0xc0ffee ^ dpr`) but emits a `THREE.Points` mesh that lives
 * inside the renderer's scene. Now that the renderer is real
 * three.js, the starfield is one child of many — its presence is
 * the "sceneChildCount >= 1" gate the e2e contract checks, and
 * the deterministic positions the future TASK-71 determinism
 * tests will pin.
 *
 * The mesh is parented to a group that gets pre-rotated far back
 * along -Z. Moving it off the origin keeps any future camera
 * handoff that resets the rig from re-tiling the field.
 *
 * Module surface:
 *   - {@link STAR_COUNT} / {@link STAR_SEED} — the same constants
 *     TASK-70 pinned, exported for tests.
 *   - {@link makeStarRng} — the deterministic LCG kept verbatim
 *     from `components/CanvasStage.tsx`. Future determinism tests
 *     can re-seed and assert pixel-level parity with TASK-70
 *     snapshots.
 *   - {@link createStarfield} — assembles and returns the
 *     `THREE.Points` mesh. The caller adds it to the scene.
 *
 * The mesh disposes cleanly: `dispose()` releases the geometry's
 * `BufferAttribute`s and the material; the RenderHost tears it
 * down in `dispose()`.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  type Object3D,
  Points,
  PointsMaterial,
} from "three";

/**
 * Number of stars in the field. Matches TASK-70's `STAR_COUNT`
 * exactly so the pixel-density contract (and any future
 * determinism tests) does not change when the renderer swaps to
 * three.js.
 */
export const STAR_COUNT = 800;

/**
 * Distance from the camera origin to the starfield disc, in
 * world units. 1 000 places the field inside the rig's 50 000
 * far plane (`CameraRig.#_perspectiveCamera.far = 50_000`)
 * with plenty of room for the future surface stream.
 */
export const STARFIELD_DISTANCE_M = 1_000;

/**
 * Disc radius. Sized to fully cover the FOV-75° viewport at
 * STARFIELD_DISTANCE_M: `tan(37.5°) × STARFIELD_DISTANCE_M ≈
 * 765`, so a 1 000 u radius leaves a ~30 % margin on every side.
 */
export const STARFIELD_RADIUS_M = 1_000;

/**
 * Base seed for the LCG. The TASK-70 starfield XORed the DPR
 * into the seed so a canvas with 2× device pixel ratio drew a
 * slightly different field from a 1× canvas; we keep that
 * behaviour via {@link makeStarRng} so the two backgrounds match.
 */
const STAR_SEED_BASE = 0xc0ffee;

/**
 * Deterministic Linear-Congruential Generator (Numerical Recipes
 * constants). Verbatim copy of `components/CanvasStage.tsx` so
 * a future TASK-71 determinism check that re-seeds both modules
 * sees the same byte stream.
 */
export function makeStarRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0xdeadbeef;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * The full seed the generator uses. Exported so the e2e harness
 * can assert the starfield is the same shape across runs by
 * re-running `makeStarRng(starSeed(dpr))` headlessly.
 */
export function starSeed(dpr: number): number {
  return STAR_SEED_BASE ^ Math.max(1, Math.floor(dpr));
}

/**
 * Build the starfield `THREE.Points` mesh.
 *
 * @param dpr — the device pixel ratio used to seed the RNG. Kept
 *             as a parameter (instead of reading
 *             `window.devicePixelRatio`) so the e2e suite can
 *             drive a deterministic value if it ever needs to.
 *
 * The mesh is positioned at the origin. The `Points` material
 * uses additive blending so overlapping stars sum rather than
 * occlude, and per-point `vertexColors` so each star's brightness
 * shows up as a colour tone on screen. Star positions are in the
 * XY plane (the field is the same 2D disc TASK-70 used) but the
 * mesh renders at z = -1000 so it always sits in front of the
 * clear colour from the camera's POV regardless of the rig.
 *
 * Brightness mapping (the same 90/10 split TASK-70 used):
 *   - 90 % dim stars: brightness 0.25-0.6, grey-white.
 *   - 10 % bright stars: brightness 0.7-1.0, blue-white.
 */
export function createStarfield(dpr: number): Points<BufferGeometry, PointsMaterial> {
  const rng = makeStarRng(starSeed(dpr));

  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);

  // Layout: stars live on a disc at z = +STARFIELD_DISTANCE_M
  // facing the default camera pose (origin, look-at (0, 0, 1)).
  // The disc is wider than the visible frustum so stars fill the
  // viewport edge-to-edge when the rig has no targets yet — the
  // background must look full even before the first ship state
  // lands. Future camera handoffs (TASK-26+) will tilt the rig;
  // `frustumCulled = false` below keeps the disc from clipping
  // when the handoff rotates the camera away from the disc's
  // normal. The radius sqrt(rng()) distribution preserves TASK-70's
  // uniform-density radial placement (a flat radius distribution
  // clusters stars near the centre).
  for (let i = 0; i < STAR_COUNT; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * STARFIELD_RADIUS_M;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius;
    positions[i * 3 + 2] = STARFIELD_DISTANCE_M;

    const isBright = rng() < 0.1;
    const brightness = isBright ? 0.7 + rng() * 0.3 : 0.25 + rng() * 0.35;
    // Slight blue tint on the bright stars, grey-white on the dim.
    const coldness = brightness; // dim stars are grey-white anyway
    colors[i * 3] = brightness * (isBright ? 0.85 + 0.15 * coldness : 0.85);
    colors[i * 3 + 1] = brightness * (isBright ? 0.9 + 0.1 * coldness : 0.9);
    colors[i * 3 + 2] = brightness;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  // We don't use an index buffer — the geometry is trivially
  // non-indexed and the renderer treats it as `gl.POINTS` either
  // way.

  const material = new PointsMaterial({
    size: 2.5,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    // Match the TASK-70 fragment shader's "soft circle" look as
    // closely as three.js can without a custom shader: the
    // default map is a hard square, but a starfield is dense
    // enough that the visual difference is invisible at this
    // density. We deliberately do NOT add a circular alpha-map
    // texture here so the module stays offline-buildable without
    // a blob.
  });

  const points = new Points(geometry, material);
  // `frustumCulled = false` so the disc never disappears on a
  // camera handoff — the field is a backdrop, not a 3-D prop.
  points.frustumCulled = false;
  return points;
}

/**
 * Dispose the geometry + material of a starfield mesh produced
 * by {@link createStarfield}. The RenderHost's `dispose()` calls
 * this so the loop's rAF cleanly tears down between scene
 * swaps.
 *
 * It is also the host's generic "release this scene child" call, so
 * it has to tolerate children that own no GPU buffers (TASK-75
 * added the light rig group). Anything without a `geometry` is a
 * no-op.
 */
export function disposeStarfield(points: Object3D): void {
  // Three.js' `Points` exposes the geometry via `geometry` (cast
  // back from `Object3D`); the material is just `material`.
  const mesh = points as Points<BufferGeometry, PointsMaterial>;
  if (mesh.geometry === undefined || mesh.material === undefined) return;
  mesh.geometry.dispose();
  mesh.material.dispose();
}

/** A debug seam — the "cold-ish white" base colour a 0-brightness star would render as. */
export const STARFIELD_TINT: Color = new Color(1, 1, 1);
