/**
 * Public surface of the system-body render module — TASK-76.
 *
 * The seed-derived body description lives in
 * `@client/world/systemBodies`; this barrel re-exports the layer
 * plus the palette constants the unit tests pin.
 *
 * @see ./SystemBodyLayer.ts — the three.js layer (React-free).
 */

export {
  ATMOSPHERE_COLOUR,
  ATMOSPHERE_SHELL_SCALE,
  STAR_LIGHT_INTENSITY,
  PLANET_COLOURS,
  STAR_COLOURS,
  SystemBodyLayer,
} from "./SystemBodyLayer.js";
export type { SystemBodyLayerOptions, SystemBodySyncOptions } from "./SystemBodyLayer.js";
