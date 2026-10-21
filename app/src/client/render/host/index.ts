/**
 * Public surface of the render host module — TASK-73.
 *
 * Production consumers import from `@client/render/host` (this
 * barrel). Tests reach into the individual files when they need
 * the seams; the barrel re-exports everything they need.
 *
 * @see ./RenderHost.ts   — the renderer / scene / rig owner.
 * @see ./loop.ts         — the rAF driver.
 * @see ./background.ts   — the deterministic starfield mesh.
 * @see ./GameCanvas.tsx  — the React component that mounts it.
 */

export { RenderHost, RENDER_HOST_CLEAR_COLOR } from "./RenderHost.js";
export type { RenderHostOptions, RendererInfoSlice } from "./RenderHost.js";

export {
  DEFAULT_FIXED_STEP_SECONDS,
  DEFAULT_MAX_SUBSTEPS,
  LOOP_GUARD_KEY,
  applyResize,
  startFrameLoop,
} from "./loop.js";
export type { FrameLoopHandle, FrameLoopOptions, RenderHostLike } from "./loop.js";

export {
  STAR_COUNT,
  createStarfield,
  disposeStarfield,
  makeStarRng,
  starSeed,
} from "./background.js";

export {
  AMBIENT_INTENSITY,
  FILL_INTENSITY,
  KEY_INTENSITY,
  createSceneLighting,
  lightingLightCount,
} from "./lighting.js";

export { GameCanvas } from "./GameCanvas.js";
export type { GameCanvasProps } from "./GameCanvas.js";
