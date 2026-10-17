/**
 * Barrel re-export for the in-process galaxy router (TASK-11).
 *
 * The router lives at `./router.ts`. Keep this file thin — just the
 * named exports — so the AGENTS.md file-size cap stays respected by
 * each underlying module.
 */
export {
  GalaxyRouter,
  type JoinRejection,
  type JoinResult,
  type RouterConnectionContext,
  type RouterOptions,
  type RouterShardStats,
  type RouterStats,
} from "./router.js";

export {
  buildShardContext,
  findStar,
  GalaxySystemNotFoundError,
  type BuildShardContextOptions,
} from "./system-data.js";
