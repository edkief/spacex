import React from 'react';

import {
  DEFAULT_SETTINGS,
  QUALITY_PRESETS,
  SETTING_KEYS,
  type QualityPreset,
  type Settings,
} from '@shared/settings';
import {
  settingsState,
  settingsSubscribe,
  setQuality,
  setSensitivity,
  setSetting,
} from '@client/a11y/reduced-motion';
import { putSettings } from '@client/net/settings-api';

/**
 * The settings panel (TASK-55) — the four sections of the ESC menu's
 * SETTINGS entry: quality preset, mouse sensitivity, reduced motion, and
 * the keybind list. Changes apply LIVE (no Apply button): the preset and
 * the toggle fire immediately, the slider is debounced 300 ms. Every local
 * change is followed by a PUT (the persistence round trip is the AC: a new
 * session on any machine restores the last settings). Reset returns all
 * three to the factory defaults in ONE PUT.
 */

/** Re-render the panel on any store change (the live bridge keeps it in sync). */
function useSettings(): Settings {
  const [s, setS] = React.useState<Settings>(settingsState());
  React.useEffect(() => settingsSubscribe(setS), []);
  return s;
}

/** The v1 keybind list — INFORMATIONAL ONLY (no rebinding in v1; the
 *  input map, TASK-25, is fixed — the spec says so on the surface). */
const KEYBINDS: Array<[string, string]> = [
  ['WASD + mouse', 'move / look'],
  ['E', 'interact'],
  ['T', 'target'],
  ['1 / 2', 'weapon'],
  ['M', 'chart'],
  ['ESC', 'menu'],
  ['F3', 'debug'],
  ['Enter', 'chat'],
];

const SECTION_STYLE: React.CSSProperties = {
  marginTop: '0.75rem',
  marginBottom: '0.1rem',
  fontSize: '0.65rem',
  letterSpacing: '0.2em',
  color: '#6b7f96',
};

const PRESET_STYLE: React.CSSProperties = {
  flex: 1,
  background: 'none',
  border: '1px solid #2c3a4d',
  borderRadius: '4px',
  color: '#9fb0c3',
  fontFamily: 'inherit',
  fontSize: '0.7rem',
  letterSpacing: '0.1em',
  padding: '0.3rem 0',
  cursor: 'pointer',
};

export interface SettingsPanelProps {
  /** The session bearer token (the PUTs' auth — the panel never holds
   *  credentials of its own). null until the session boots. */
  token: string | null;
}

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const s = useSettings();
  // 300 ms debounce for the slider: 5 rapid drags → 1 PUT (the AC).
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const put = (update: Parameters<typeof putSettings>[1]): void => {
    if (props.token) void putSettings(props.token, update);
  };

  const onPreset = (q: QualityPreset): void => {
    setQuality(q); // immediate: the chunk streamer's live LOD radii update
    put({ quality: q });
  };

  const onSensitivityInput = (value: number): void => {
    setSensitivity(value); // applied on the NEXT input frame (live)
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => put({ sensitivity: value }), 300);
  };

  const onToggleReduced = (on: boolean): void => {
    setSetting(SETTING_KEYS.reducedMotion, on); // immediate (TASK-54 contract)
    put({ [SETTING_KEYS.reducedMotion]: on });
  };

  const onReset = (): void => {
    setQuality(DEFAULT_SETTINGS.quality);
    setSensitivity(DEFAULT_SETTINGS.sensitivity);
    setSetting(SETTING_KEYS.reducedMotion, DEFAULT_SETTINGS[SETTING_KEYS.reducedMotion]);
    put({
      quality: DEFAULT_SETTINGS.quality,
      sensitivity: DEFAULT_SETTINGS.sensitivity,
      [SETTING_KEYS.reducedMotion]: DEFAULT_SETTINGS[SETTING_KEYS.reducedMotion],
    });
  };

  return (
    <div id="settings-panel" style={{ marginTop: '0.75rem' }}>
      <div id="settings-quality" style={SECTION_STYLE}>
        QUALITY
      </div>
      <div style={{ display: 'flex', gap: '0.35rem' }}>
        {QUALITY_PRESETS.map((q) => (
          <button
            key={q}
            id={`settings-quality-${q}`}
            type="button"
            aria-pressed={s.quality === q}
            style={{ ...PRESET_STYLE, borderColor: s.quality === q ? '#4a6fa5' : '#2c3a4d' }}
            onClick={() => onPreset(q)}
          >
            {q.toUpperCase()}
          </button>
        ))}
      </div>

      <div id="settings-sensitivity" style={SECTION_STYLE}>
        SENSITIVITY <span id="settings-sensitivity-value">{s.sensitivity.toFixed(1)}x</span>
      </div>
      <input
        id="settings-sensitivity-slider"
        type="range"
        min={0.5}
        max={2}
        step={0.1}
        value={s.sensitivity}
        aria-label="Mouse sensitivity"
        onChange={(e) => onSensitivityInput(Number(e.target.value))}
      />

      <div id="settings-motion" style={SECTION_STYLE}>
        MOTION
      </div>
      <button
        id="reduced-motion-toggle"
        type="button"
        role="switch"
        aria-checked={s['reduced-motion']}
        onClick={() => onToggleReduced(!s['reduced-motion'])}
        style={{ ...PRESET_STYLE, flex: 'none', padding: '0.3rem 0.75rem' }}
      >
        REDUCED MOTION: {s['reduced-motion'] ? 'ON' : 'OFF'}
      </button>

      <div id="settings-keybinds-heading" style={SECTION_STYLE}>
        KEYBINDS
      </div>
      {/* v1: no rebinding (scope cut) — the list is informational. */}
      <ul id="settings-keybinds" style={{ margin: '0 0 0 1rem', fontSize: '0.7rem' }}>
        {KEYBINDS.map(([key, what]) => (
          <li key={key}>
            <span style={{ color: '#e6edf3' }}>{key}</span> — {what}
          </li>
        ))}
      </ul>

      <button
        id="settings-reset"
        type="button"
        onClick={onReset}
        style={{ ...PRESET_STYLE, marginTop: '0.75rem', width: '100%' }}
      >
        RESET TO DEFAULTS
      </button>
    </div>
  );
}
