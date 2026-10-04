/**
 * Shared settings keys (TASK-54, owned by TASK-55). The single source of
 * truth for setting identity: the client settings store (TASK-55) persists
 * user values under these keys, and consumers (the TASK-54 reduced-motion
 * FX gate, TASK-54's threat-ping/warp overlays) read the flag through the
 * client store (`@client/a11y/reduced-motion`) — never by string-literal.
 */
export const SETTING_KEYS = {
  reducedMotion: 'reduced-motion',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface Settings {
  /**
   * Reduced motion (TASK-54): disables camera shake, slow-mo, particle FX
   * (debris/smoke/trails), the threat-ping animation (a static icon is
   * shown instead) and the warp streak (a simple fade instead). Default OFF.
   * The toggle takes effect immediately — consumers subscribe, no restart.
   */
  [SETTING_KEYS.reducedMotion]: boolean;
}

/** Factory defaults (v1 ships with reduced motion OFF). */
export const DEFAULT_SETTINGS: Settings = {
  [SETTING_KEYS.reducedMotion]: false,
};
