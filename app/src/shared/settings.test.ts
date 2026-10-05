/**
 * TASK-55: the settings model — preset table (the AC pins these values),
 * sensitivity clamp + scaling math, normalization of untrusted rows, and
 * the PUT boundary (bad preset rejected, out-of-range clamped).
 */
import { describe, expect, it } from 'vitest';

import {
  applySettingsUpdate,
  clampSensitivity,
  DEFAULT_SETTINGS,
  lodRadiiFor,
  normalizeSettings,
  PRESETS,
  QUALITY_PRESETS,
  scaleLookDemand,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SettingsUpdateSchema,
} from '@shared/settings';

describe('PRESETS (the spec table)', () => {
  it('high: 8 km draw distance, full chunk detail, 2500 stars, fx 1.0, shadowless', () => {
    expect(PRESETS.high).toEqual({
      chunkDetail: { nearTris: 8192, midTris: 2048, farTris: 2 },
      drawDistanceKm: 8,
      starCount: 2500,
      fxQuality: 1.0,
      shadowless: true,
    });
    // high matches the pipeline's ORIGINAL constants (default behavior
    // is bit-identical — the existing streaming suite is the canary).
    expect(lodRadiiFor('high')).toEqual({ nearMaxM: 512, midMaxM: 2048, farMaxM: 8000 });
  });

  it('medium: 6 km, halved budget, 1250 stars, fx 0.6, shadowless', () => {
    expect(PRESETS.medium).toEqual({
      chunkDetail: { nearTris: 2048, midTris: 512, farTris: 2 },
      drawDistanceKm: 6,
      starCount: 1250,
      fxQuality: 0.6,
      shadowless: true,
    });
    expect(lodRadiiFor('medium')).toEqual({ nearMaxM: 512, midMaxM: 1536, farMaxM: 6000 });
  });

  it('low: 4 km, quarter budget, 500 stars, fx 0.3, shadowless', () => {
    expect(PRESETS.low).toEqual({
      chunkDetail: { nearTris: 512, midTris: 128, farTris: 2 },
      drawDistanceKm: 4,
      starCount: 500,
      fxQuality: 0.3,
      shadowless: true,
    });
    expect(lodRadiiFor('low')).toEqual({ nearMaxM: 384, midMaxM: 1024, farMaxM: 4000 });
  });

  it('the preset ids are exactly high/medium/low (the panel renders these)', () => {
    expect([...QUALITY_PRESETS]).toEqual(['high', 'medium', 'low']);
  });
});

describe('sensitivity', () => {
  it('clamps out-of-range values to [0.5, 2.0]', () => {
    expect(clampSensitivity(0.5)).toBe(SENSITIVITY_MIN);
    expect(clampSensitivity(2)).toBe(SENSITIVITY_MAX);
    expect(clampSensitivity(0)).toBe(0.5);
    expect(clampSensitivity(5)).toBe(2);
    expect(clampSensitivity(1.37)).toBe(1.37);
    expect(clampSensitivity(Number.NaN)).toBe(DEFAULT_SETTINGS.sensitivity);
  });

  it('scaleLookDemand scales ONLY the look channels (thrust/VTOL untouched)', () => {
    const base = { thrust: 1, yaw: 1, pitch: -1, roll: 0.5, up: 1 };
    expect(scaleLookDemand(base, 0.5)).toEqual({
      thrust: 1,
      yaw: 0.5,
      pitch: -0.5,
      roll: 0.25,
      up: 1,
    });
    expect(scaleLookDemand(base, 1)).toEqual(base);
  });

  it('scaleLookDemand clamps the scaled demand to [-1, 1] (the flight model range)', () => {
    const scaled = scaleLookDemand({ thrust: 0, yaw: 1, pitch: 1, roll: 1, up: 0 }, 2);
    expect(scaled.yaw).toBe(1);
    expect(scaled.pitch).toBe(1);
    expect(scaled.roll).toBe(1);
  });
});

describe('normalizeSettings (the untrusted players.settings JSON)', () => {
  it('empty / corrupt rows fall back to the factory defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    // The column is a JSON STRING — the boundary parses it.
    expect(normalizeSettings('{"quality":"medium"}')).toEqual({
      ...DEFAULT_SETTINGS,
      quality: 'medium',
    });
    expect(normalizeSettings({ quality: 'ultra', sensitivity: 'fast' })).toEqual(DEFAULT_SETTINGS);
  });

  it('valid rows pass through (the persistence round-trip shape)', () => {
    const row = {
      quality: 'low',
      deviceProfile: 'auto',
      sensitivity: 0.5,
      'reduced-motion': true,
    };
    expect(normalizeSettings(row)).toEqual(row);
  });

  it('out-of-range sensitivity is clamped, not rejected', () => {
    expect(normalizeSettings({ sensitivity: 7 }).sensitivity).toBe(2);
    expect(normalizeSettings({ sensitivity: -3 }).sensitivity).toBe(0.5);
  });
});

describe('PUT boundary (SettingsUpdateSchema)', () => {
  it('a bad quality preset is rejected (the 400)', () => {
    expect(SettingsUpdateSchema.safeParse({ quality: 'ultra' }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ quality: 'high' }).success).toBe(true);
  });

  it('a non-numeric sensitivity is rejected; out-of-range parses (clamped later)', () => {
    expect(SettingsUpdateSchema.safeParse({ sensitivity: 'fast' }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ sensitivity: 99 }).success).toBe(true);
  });

  it('unknown fields are rejected (strict)', () => {
    expect(SettingsUpdateSchema.safeParse({ quality: 'low', extra: 1 }).success).toBe(false);
  });

  it('applySettingsUpdate merges partials over the stored row (clamping sensitivity)', () => {
    const stored = {
      quality: 'high',
      deviceProfile: 'auto' as const,
      sensitivity: 1,
      'reduced-motion': false,
    } as const;
    expect(applySettingsUpdate(stored, { quality: 'low' })).toEqual({
      quality: 'low',
      deviceProfile: 'auto',
      sensitivity: 1,
      'reduced-motion': false,
    });
    expect(applySettingsUpdate(stored, { sensitivity: 4 }).sensitivity).toBe(2);
    expect(applySettingsUpdate(stored, { 'reduced-motion': true })['reduced-motion']).toBe(true);
  });

  it('deviceProfile: schema + normalize + update (TASK-59)', () => {
    expect(SettingsUpdateSchema.safeParse({ deviceProfile: 'mobile' }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ deviceProfile: 'tablet' }).success).toBe(false);
    expect(normalizeSettings(undefined).deviceProfile).toBe('auto');
    expect(normalizeSettings({ deviceProfile: 'mobile' }).deviceProfile).toBe('mobile');
    expect(normalizeSettings({ deviceProfile: 'nvidia' }).deviceProfile).toBe('auto');
    expect(normalizeSettings('{"deviceProfile":"desktop"}').deviceProfile).toBe('desktop');
    expect(
      applySettingsUpdate({ ...DEFAULT_SETTINGS }, { deviceProfile: 'mobile' }).deviceProfile,
    ).toBe('mobile');
    expect(
      applySettingsUpdate({ ...DEFAULT_SETTINGS, deviceProfile: 'mobile' }, {}).deviceProfile,
    ).toBe('mobile');
  });
});
