/**
 * Barrel for the first-launch guidance module (TASK-56).
 *
 * Re-exports the step table (`./guidance/steps.js`) and the state
 * machine (`./guidance/GuidanceStore.js`) so existing imports keep
 * resolving while the implementation stays split by concern.
 */
export * from "./guidance/steps.js";
export * from "./guidance/GuidanceStore.js";
