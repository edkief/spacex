/**
 * Public surface of the chunk-streaming module (TASK-26).
 *
 * The render loop's render-side glue should import from
 * `@client/world` (this barrel) rather than reaching into the
 * individual files. Keeps the import graph in one place so the
 * orchestrator can be swapped (worker thread, WebGPU, …) without
 * touching the consumer.
 */

export {
  ACTIVE_SET_RADIUS_DEFAULT,
  ACTIVE_SET_RADIUS_FAST,
  CHUNK_LRU_CAPACITY,
  CHUNK_SIZE_M,
  DATA_CHUNKS_PER_RENDER_CHUNK,
  FAST_MOVEMENT_SPEED_MPS,
  LOD_FAR_RADIUS_M,
  LOD_MID_RADIUS_M,
  LOD_NEAR_RADIUS_M,
  LOD_RING_RADII_M,
  NEAR_GRID,
  MID_GRID,
  FAR_GRID,
  DEFAULT_CHUNK_DETAIL,
  TRIANGLE_BUDGET_DEFAULT,
  chunkCoordFor,
  chunkKey,
  chunkWorldCentre,
  computeActiveSet,
  generateChunk,
  buildHeightGrid,
  buildLodGeometry,
  lodFor,
  sampleHeightAt,
  ChunkLruCache,
  TriangleBudget,
  type ActiveChunk,
  type ChunkLOD,
  type ChunkClock,
  type LodGeometry,
  type LodVertex,
  type RenderChunk,
  type ChunkGeometries,
  type ChunkDetail,
} from "./chunks.js";

export { FrameScheduler, type FrameSchedulerOptions, type FrameTask } from "./frameScheduler.js";

export {
  SettingsBridge,
  settingsBridge,
  connectSettingsBridge,
  type ParamsListener,
} from "./settingsBridge.js";

export {
  ChunkPipeline,
  type ChunkPipelineCallbacks,
  type ChunkPipelineOptions,
  type ChunkPipelineStats,
} from "./pipeline.js";
