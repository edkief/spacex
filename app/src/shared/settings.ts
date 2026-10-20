/**
 * Player settings model — TASK-55.
 *
 * The persisted per-player settings are three values: a **quality
 * preset**, a **mouse sensitivity** multiplier, and the
 * **reduced-motion** flag (owned by the a11y store since TASK-54).
 *
 * The quality preset is the only interesting one: it is *not*
 * stored as raw pipeline numbers, it is a named preset that maps
 * onto a concrete {@link PipelineParams} table (draw distance, chunk
 * vertex counts per LOD ring, star count, the FX spawn multiplier).
 * Keeping the mapping here — in `shared/`, not in the client — means
 * the server can validate a PUT body with the exact same table the
 * renderer reads, and the unit suite can assert the mapping without
 * a browser.
 *
 * ```
 * QUALITY_PRESETS.high -> { drawDistanceM: 8000, chunkDetail: {near:64,mid:32,far:8}, ... }
 * ```
 */
import { z } from "zod";

/** The three quality presets offered in the settings panel. */
export type QualityPreset = "high" | "medium" | "low";

/** The settings record persisted per player (`players.settings` JSON). */
export interface Settings {
  /** Quality preset id (default `high`). */
  readonly quality: QualityPreset;
  /** Mouse-look sensitivity multiplier, 0.5 – 2.0 (default `1.0`). */
  readonly sensitivity: number;
  /** Reduced-motion flag — TASK-54, default `false`. */
  readonly reducedMotion: boolean;
}

/**
 * Concrete renderer budgets a preset expands into. Every field is
 * read per chunk generation (via the client's `SettingsBridge`), so
 * changing the preset re-tunes the pipeline live — no re-init, no
 * reload, no pop (already-cached chunks keep their LOD until they
 * are regenerated).
 */
export interface PipelineParams {
  /** Cells (grid resolution) per chunk side for each LOD ring. */
  readonly chunkDetail: { readonly near: number; readonly mid: number; readonly far: number };
  /** Far draw distance in metres (8 / 6 / 4 km). */
  readonly drawDistanceM: number;
  /** Number of background stars in the sky sphere. */
  readonly starCount: number;
  /** Multiplier on every cosmetic FX spawn rate (1.0 / 0.6 / 0.3). */
  readonly fxQuality: number;
  /**
   * Dynamic shadows are not implemented in v1, so every preset is
   * shadowless. The flag exists so the future shadow pass has a
   * per-preset switch to read instead of a magic constant.
   */
  readonly shadowless: true;
}

/** The preset table — the single source of truth for the mapping. */
export const QUALITY_PRESETS: Readonly<Record<QualityPreset, PipelineParams>> = Object.freeze({
  high: Object.freeze({
    chunkDetail: Object.freeze({ near: 64, mid: 32, far: 8 }),
    drawDistanceM: 8_000,
    starCount: 3_000,
    fxQuality: 1.0,
    shadowless: true,
  }),
  medium: Object.freeze({
    chunkDetail: Object.freeze({ near: 32, mid: 16, far: 8 }),
    drawDistanceM: 6_000,
    starCount: 2_000,
    fxQuality: 0.6,
    shadowless: true,
  }),
  low: Object.freeze({
    chunkDetail: Object.freeze({ near: 16, mid: 8, far: 4 }),
    drawDistanceM: 4_000,
    starCount: 1_000,
    fxQuality: 0.3,
    shadowless: true,
  }),
});

/** Preset ids in the order the panel renders them. */
export const QUALITY_PRESET_IDS: readonly QualityPreset[] = Object.freeze([
  "high",
  "medium",
  "low",
] as const);

/** Sensitivity bounds (inclusive) + slider step. */
export const SENSITIVITY_MIN = 0.5;
export const SENSITIVITY_MAX = 2.0;
export const SENSITIVITY_STEP = 0.1;

/** The shipped defaults — a fresh player starts here. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  quality: "high",
  sensitivity: 1.0,
  reducedMotion: false,
});

/** zod schema for the persisted / PUT record (partial on the wire). */
export const SettingsSchema = z.object({
  quality: z.enum(["high", "medium", "low"]),
  sensitivity: z
    .number()
    .min(SENSITIVITY_MIN)
    .max(SENSITIVITY_MAX)
    .refine((n) => Number.isFinite(n), { message: "sensitivity must be finite" }),
  reducedMotion: z.boolean(),
});

/**
 * Clamp a sensitivity value into `[0.5, 2.0]` and snap it to the
 * 0.1 slider step. Non-finite input (NaN from a corrupt payload)
 * falls back to the default `1.0`.
 */
export function clampSensitivity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.sensitivity;
  const clamped = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, n));
  // Snap to the nearest 0.1 step and kill float dust (1.2000000000000002).
  return Math.round(clamped * 10) / 10;
}

/**
 * Coerce anything into a valid {@link Settings} record. Bad presets
 * and bad booleans fall back to the default; sensitivity is clamped
 * (per the spec: out-of-range sensitivity is clamped, not rejected).
 */
export function sanitizeSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) return DEFAULT_SETTINGS;
  const raw = input as Partial<Record<keyof Settings, unknown>>;
  const quality = QUALITY_PRESET_IDS.includes(raw.quality as QualityPreset)
    ? (raw.quality as QualityPreset)
    : DEFAULT_SETTINGS.quality;
  return {
    quality,
    sensitivity: clampSensitivity(raw.sensitivity ?? DEFAULT_SETTINGS.sensitivity),
    reducedMotion:
      typeof raw.reducedMotion === "boolean" ? raw.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
  };
}

/** The pipeline params for a preset (falls back to `high`). */
export function pipelineParamsFor(quality: QualityPreset): PipelineParams {
  return QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
}

/** Base mouse-look sensitivity: radians of yaw/pitch per pixel at 1.0×. */
export const LOOK_RAD_PER_PIXEL = 0.0022;

/**
 * Scale a raw mouse-look delta (pixels) by the player's sensitivity.
 * `sensitivity: 2` doubles the rotation per pixel; `0.5` halves it.
 */
export function scaleLookDelta(deltaPx: number, sensitivity: number): number {
  return deltaPx * LOOK_RAD_PER_PIXEL * clampSensitivity(sensitivity);
}

/** One row of the read-only keybind list (v1 has no rebinding). */
export interface KeybindRow {
  readonly keys: string;
  readonly action: string;
  readonly note?: string;
}

/**
 * The default keybinds, displayed read-only in the settings panel.
 * Mirrors the schemes in `@client/input/controls` (TASK-25); v1
 * ships no rebinding, so the list is informational.
 */
export const KEYBINDS: readonly KeybindRow[] = Object.freeze([
  Object.freeze({ keys: "W A S D + mouse", action: "Thrust / strafe / look" }),
  Object.freeze({ keys: "E", action: "Interact" }),
  Object.freeze({ keys: "T", action: "Target nearest" }),
  Object.freeze({ keys: "1 / 2", action: "Select weapon" }),
  Object.freeze({ keys: "M", action: "Star chart" }),
  Object.freeze({ keys: "ESC", action: "Menu" }),
  Object.freeze({ keys: "F3", action: "Debug overlay" }),
  Object.freeze({ keys: "Enter", action: "Chat" }),
]);
