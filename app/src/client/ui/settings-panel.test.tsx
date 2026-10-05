// @vitest-environment happy-dom
/**
 * TASK-55: the settings panel — the preset switch RE-TUNES THE PIPELINE
 * (the chunk streamer's live LOD radii update through the SettingsBridge,
 * no re-init), the sensitivity slider is debounced 300 ms (5 rapid drags
 * → 1 PUT), and every change persists (a PUT per local change; Reset is
 * ONE PUT with all three defaults).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, lodRadiiFor } from '@shared/settings';
import { lodRadii, setLodRadii } from '@client/world/chunks';
import { __resetSettings, settingsState, setQuality } from '@client/a11y/reduced-motion';
import { SettingsPanel } from './settings-panel';

let roots: Root[] = [];

function renderPanel(token: string | null = 'tok'): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<SettingsPanel token={token} />);
  });
  roots.push(root);
  return container;
}

const click = (el: HTMLDivElement, id: string): void => {
  act(() => {
    el.querySelector<HTMLButtonElement>(id)?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
};

/** Fire a range input's change with a value (a "drag step"). */
const drag = (el: HTMLDivElement, value: number): void => {
  const slider = el.querySelector<HTMLInputElement>('#settings-sensitivity-slider');
  act(() => {
    // React's controlled range: set the value through the native setter,
    // then fire 'input' (React maps range onChange onto the input event).
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      slider,
      String(value),
    );
    slider?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  __resetSettings();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('SettingsPanel (TASK-55)', () => {
  it('renders the four sections + reset with the live store values', () => {
    const el = renderPanel();
    expect(el.querySelector('#settings-panel')).not.toBeNull();
    expect(el.querySelector('#settings-quality-high')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('#settings-sensitivity-slider')?.getAttribute('value')).toBe('1');
    expect(el.querySelector('#reduced-motion-toggle')?.getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('#settings-keybinds')?.textContent).toContain('WASD');
    expect(el.querySelector('#settings-keybinds')?.textContent).toContain('Enter');
  });

  it('a preset switch re-tunes the pipeline LIVE (the streaming config updates)', () => {
    const el = renderPanel();
    expect(lodRadii()).toEqual(lodRadiiFor('high'));
    click(el, '#settings-quality-low');
    // The chunk streamer's live radii are the low preset's — no reload.
    expect(lodRadii()).toEqual(lodRadiiFor('low'));
    expect(settingsState().quality).toBe('low');
    expect(el.querySelector('#settings-quality-low')?.getAttribute('aria-pressed')).toBe('true');
    // And back up:
    click(el, '#settings-quality-medium');
    expect(lodRadii()).toEqual(lodRadiiFor('medium'));
    setLodRadii(lodRadiiFor(DEFAULT_SETTINGS.quality));
  });

  it('the slider is debounced 300 ms: 5 rapid drags → 1 PUT (at the latest value)', async () => {
    const putSpy = vi.fn(
      async (_url: string, _init: { method?: string; body?: string }): Promise<boolean> => true,
    );
    vi.stubGlobal('fetch', putSpy);
    const el = renderPanel();
    for (const v of [0.8, 1.1, 1.6, 1.9, 2.0]) {
      drag(el, v);
      // Nothing yet while the debounce window is open.
      expect(putSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(299);
    }
    vi.advanceTimersByTime(1);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [url, init] = putSpy.mock.calls[0];
    expect(url).toBe('/api/players/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body ?? '')).toEqual({ sensitivity: 2 });
    // The local store applied the LAST drag immediately (live).
    expect(settingsState().sensitivity).toBe(2);
  });

  it('the reduced-motion toggle persists immediately (no debounce)', async () => {
    const putSpy = vi.fn(
      async (_url: string, _init: { method?: string; body?: string }): Promise<boolean> => true,
    );
    vi.stubGlobal('fetch', putSpy);
    const el = renderPanel();
    click(el, '#reduced-motion-toggle');
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(putSpy.mock.calls[0][1].body ?? '')).toEqual({ 'reduced-motion': true });
  });

  it('Reset sends ONE PUT with all three defaults and re-tunes the pipeline', async () => {
    const putSpy = vi.fn(
      async (_url: string, _init: { method?: string; body?: string }): Promise<boolean> => true,
    );
    vi.stubGlobal('fetch', putSpy);
    const el = renderPanel();
    // Dirty the local state first (the pipeline rides along).
    act(() => setQuality('low'));
    expect(lodRadii()).toEqual(lodRadiiFor('low'));
    click(el, '#settings-reset');
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(putSpy.mock.calls[0][1].body ?? '')).toEqual({
      quality: 'high',
      sensitivity: 1,
      'reduced-motion': false,
    });
    expect(lodRadii()).toEqual(lodRadiiFor('high'));
  });

  it('with no token the panel applies changes locally but sends nothing', () => {
    const putSpy = vi.fn(
      async (_url: string, _init: { method?: string; body?: string }): Promise<boolean> => true,
    );
    vi.stubGlobal('fetch', putSpy);
    const el = renderPanel(null);
    click(el, '#settings-quality-low');
    expect(settingsState().quality).toBe('low');
    expect(putSpy).not.toHaveBeenCalled();
  });
});
