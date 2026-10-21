/**
 * Public surface of the remote-entity render module — TASK-75.
 *
 * @see ./entityMeshFactory.ts  — kind → mesh (exhaustive record).
 * @see ./entityPalette.ts     — shared primitive materials.
 * @see ./entityPool.ts        — per-kind free list.
 * @see ./RemoteEntityLayer.ts — per-frame sync against the
 *                                snapshot buffers.
 */
export {
  ENTITY_MESH_BUILDERS,
  HOSTILE_SHIP_LIVERY,
  PROTOCOL_ENTITY_KINDS,
  REMOTE_SHIP_LIVERY,
  SPIN_RATE_KEY,
  buildEntityMesh,
  disposeEntityMesh,
} from "./entityMeshFactory.js";
export type { EntityMeshBuilder, EntityMeshContext, PaletteSlot } from "./entityMeshFactory.js";

export { SHARED_MATERIAL_KEY, sharedMaterial, sharedMaterialCount } from "./entityPalette.js";

export { DEFAULT_POOL_MAX_PER_KIND, EntityMeshPool } from "./entityPool.js";
export type { EntityMeshPoolOptions } from "./entityPool.js";

export {
  DEFAULT_REMOTE_KIND,
  REMOTE_RELEASE_STALE_MS,
  RemoteEntityLayer,
} from "./RemoteEntityLayer.js";
export type { RemoteEntityLayerOptions } from "./RemoteEntityLayer.js";
