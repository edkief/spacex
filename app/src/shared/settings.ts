/**
 * TASK-55: the per-player settings model + quality presets.
 *
 * One shared type used by THREE parties:
 * - the server (players.settings JSON column, zod-validated at the repo and
 *   route boundaries — the PUT endpoint is the only writer);
 * - the client settings store (`@client/a11y/reduced-motion.ts` keeps the
 *   TASK-54 reduced-motion contract; TASK-55 adds quality + sensitivity);
 * - the render pipeline, which reads its tunables LIVE through the presets
 *   (the "SettingsBridge" pattern — a mutable ref the client updates; the
 *   chunk streamer re-reads its LOD radii on every generation, so a preset
 *   change re-tunes the pipeline without a reload).
 *
 * No key rebinding in v1 (scope cut): the keybind list in the settings
 * panel is informational only (the input map, TASK-25, stays fixed).
 */
import { z } from 'zod';
import type { ShipInput } from './physics/flight';

// --- Setting identity (TASK-54 contract — never string literals) -----------

/**
 * Shared setting keys. The single source of truth for setting identity: the
 * client settings store persists user values under these keys, and
 * consumers (the TASK-54 reduced-motion FX gate, the threat-ping / warp
 * overlays) read the flag through the client store — never by literal.
 */
export const SETTING_KEYS = {
  reducedMotion: 'reduced-motion',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

// --- Quality presets --------------------------------------------------------

/** The v1 quality preset ids (the settings panel renders exactly these). */
export type QualityPreset = 'high' | 'medium' | 'low';

export const QUALITY_PRESETS: readonly QualityPreset[] = ['high', 'medium', 'low'];

/**
 * Concrete pipeline params of one preset (TASK-26 / TASK-58 budgets):
 * - chunkDetail: the per-ring triangle budget the surface pipeline targets
 *   (the mip chain the streamer builds — high = the full near/mid
 *   densities; lower presets budget the coarser rings TASK-58 tunes);
 * - drawDistance: the far LOD ring boundary (km) — the live LOD radii the
 *   chunk streamer reads per generation (near/mid scale with it too);
 * - starCount: the deterministic starfield point count (re-read when a
 *   world is (re)built — warp / rejoin);
 * - fxQuality: multiplier on the FX spawn rate (0.3–1.0) in `@client/fx`;
 * - shadowless: v1 ships with no dynamic shadows for EVERY preset — the
 *   flag exists for the future (kept in the table so presets carry the
 *   full contract).
 */
export interface QualityParams {
  chunkDetail: { nearTris: number; midTris: number; farTris: number };
  /** Far-ring boundary in km (8 / 6 / 4). */
  drawDistanceKm: number;
  starCount: number;
  /** FX spawn-rate multiplier (1.0 / 0.6 / 0.3). */
  fxQuality: number;
  shadowless: boolean;
}

/** The preset table (the unit tests assert these values verbatim). */
export const PRESETS: Record<QualityPreset, QualityParams> = {
  high: {
    chunkDetail: { nearTris: 8192, midTris: 2048, farTris: 2 },
    drawDistanceKm: 8,
    starCount: 2500,
    fxQuality: 1.0,
    shadowless: true,
  },
  medium: {
    chunkDetail: { nearTris: 2048, midTris: 512, farTris: 2 },
    drawDistanceKm: 6,
    starCount: 1250,
    fxQuality: 0.6,
    shadowless: true,
  },
  low: {
    chunkDetail: { nearTris: 512, midTris: 128, farTris: 2 },
    drawDistanceKm: 4,
    starCount: 500,
    fxQuality: 0.3,
    shadowless: true,
  },
};

/**
 * The live LOD radii (m, player→chunk-center) for one preset: the far
 * boundary IS the draw distance; near/mid trim with it (so Low trims the
 * high-density rings too). HIGH matches the pipeline's original constants
 * (512 / 2048 / 8000) exactly — the default behavior is bit-identical.
 * The chunk streamer re-reads these per generation (the SettingsBridge:
 * no re-init, no reload).
 */
export function lodRadiiFor(preset: QualityPreset): {
  nearMaxM: number;
  midMaxM: number;
  farMaxM: number;
} {
  switch (preset) {
    case 'high':
      return { nearMaxM: 512, midMaxM: 2048, farMaxM: 8000 };
    case 'medium':
      return { nearMaxM: 512, midMaxM: 1536, farMaxM: 6000 };
    case 'low':
      return { nearMaxM: 384, midMaxM: 1024, farMaxM: 4000 };
  }
}

// --- Settings type + defaults ------------------------------------------------

export interface Settings {
  /** Quality preset (drives the pipeline params above). Default 'high'. */
  quality: QualityPreset;
  /** Mouse/look sensitivity, 0.5–2.0 (applied on the next input frame). Default 1.0. */
  sensitivity: number;
  /** Reduced motion (TASK-54). Default off. */
  [SETTING_KEYS.reducedMotion]: boolean;
}

/** Factory defaults (v1: high quality, 1.0 sensitivity, reduced motion OFF). */
export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  sensitivity: 1.0,
  [SETTING_KEYS.reducedMotion]: false,
};

/** Sensitivity bounds (the slider range; the PUT endpoint clamps to it). */
export const SENSITIVITY_MIN = 0.5;
export const SENSITIVITY_MAX = 2.0;
export const SENSITIVITY_STEP = 0.1;

/** Clamp a raw sensitivity into [0.5, 2.0] (out-of-range → nearest bound). */
export function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.sensitivity;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, value));
}

/**
 * Coerce an untrusted value (the raw players.settings JSON column — a TEXT
 * string, or a parsed object from the API) into a well-formed Settings.
 * Bad/missing fields fall back to defaults field by field — a corrupt row
 * must never break session boot.
 */
export function normalizeSettings(raw: unknown): Settings {
  let obj: unknown = raw ?? {};
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  const o = (obj ?? {}) as Record<string, unknown>;
  const quality: QualityPreset = QUALITY_PRESETS.includes(o.quality as QualityPreset)
    ? (o.quality as QualityPreset)
    : DEFAULT_SETTINGS.quality;
  return {
    quality,
    sensitivity: clampSensitivity(
      typeof o.sensitivity === 'number' ? o.sensitivity : DEFAULT_SETTINGS.sensitivity,
    ),
    [SETTING_KEYS.reducedMotion]:
      typeof o[SETTING_KEYS.reducedMotion] === 'boolean'
        ? (o[SETTING_KEYS.reducedMotion] as boolean)
        : DEFAULT_SETTINGS[SETTING_KEYS.reducedMotion],
  };
}

// --- Sensitivity scaling (client input loops use this) -----------------------

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Scale the LOOK channels of a flight input by the sensitivity (flight
 * yaw/pitch/roll). Thrust and VTOL lift are movement, not look, and are
 * never scaled. Result is clamped to the flight model's [-1, 1] demand
 * range (the server re-clamps anyway). Pure — shared by the unit tests and
 * (indirectly, via the wire frame) the server sim.
 */
export function scaleLookDemand(input: ShipInput, sensitivity: number): ShipInput {
  const s = clampSensitivity(sensitivity);
  return {
    ...input,
    yaw: clampUnit(input.yaw * s),
    pitch: clampUnit(input.pitch * s),
    roll: clampUnit(input.roll * s),
  };
}

// --- API validation (the PUT endpoint boundary) ------------------------------

/**
 * The PUT /api/players/settings body: every field optional (partial update,
 * merged over the stored row). Quality must be a known preset (bad value →
 * 400); sensitivity must be a finite number (out-of-range is CLAMPED, not
 * rejected — the AC); reducedMotion must be a boolean.
 */
export const SettingsUpdateSchema = z
  .object({
    quality: z.enum(['high', 'medium', 'low']).optional(),
    sensitivity: z.number().finite().optional(),
    [SETTING_KEYS.reducedMotion]: z.boolean().optional(),
  })
  .strict();

export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

/** Merge a validated partial update over a stored row → a full Settings. */
export function applySettingsUpdate(stored: Settings, update: SettingsUpdate): Settings {
  return {
    quality: update.quality ?? stored.quality,
    sensitivity:
      update.sensitivity !== undefined ? clampSensitivity(update.sensitivity) : stored.sensitivity,
    [SETTING_KEYS.reducedMotion]:
      update[SETTING_KEYS.reducedMotion] ?? stored[SETTING_KEYS.reducedMotion],
  };
}
