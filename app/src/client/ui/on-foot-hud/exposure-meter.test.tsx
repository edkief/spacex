// @vitest-environment happy-dom
/**
 * TASK-52: exposure meter tests — the exact color thresholds (green > 25,
 * amber 10-25, red < 10), the hazard icons, the RECOVERING state (frozen
 * bar, pulsing red) and the 5 s countdown (fake timers — the deadline is
 * server truth, the tick is cosmetic), and the unmount-when-clear rule.
 * Live rendering (createRoot + act) so the countdown interval runs.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXPOSURE_MAX } from '@shared/world/hazards';

import { __resetHazards, setHazardFrame } from '@client/state/hazards';

import {
  EXPOSURE_CRIT_BELOW,
  EXPOSURE_WARN_AT,
  ExposureMeter,
  exposureColor,
  exposureIcon,
  recoveringSeconds,
} from './exposure-meter';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  __resetHazards();
});

function mount(): void {
  act(() => root.render(<ExposureMeter />));
}

describe('exposure helpers (TASK-52)', () => {
  it('exact color thresholds: green > 25, amber 10-25, red < 10', () => {
    expect(exposureColor(EXPOSURE_MAX)).toBe('#4ade80');
    expect(exposureColor(26)).toBe('#4ade80');
    expect(exposureColor(25.1)).toBe('#4ade80');
    expect(exposureColor(EXPOSURE_WARN_AT)).toBe('#f59e0b'); // 25 → amber
    expect(exposureColor(15)).toBe('#f59e0b');
    expect(exposureColor(EXPOSURE_CRIT_BELOW)).toBe('#f59e0b'); // 10 → amber
    expect(exposureColor(9.9)).toBe('#ef4444'); // red
    expect(exposureColor(0)).toBe('#ef4444');
  });

  it('the icon is per active hazard kind (rad zone ☢, storm ⚡, clear none)', () => {
    expect(exposureIcon('radzone')).toBe('☢');
    expect(exposureIcon('storm')).toBe('⚡');
    expect(exposureIcon(null)).toBeNull();
  });

  it('the countdown is whole seconds remaining (clamped at 0)', () => {
    const now = 1_000_000;
    expect(recoveringSeconds(now + 5_000, now)).toBe(5);
    expect(recoveringSeconds(now + 4_999, now)).toBe(5);
    expect(recoveringSeconds(now + 1_000, now)).toBe(1);
    expect(recoveringSeconds(now + 1, now)).toBe(1);
    expect(recoveringSeconds(now, now)).toBe(0);
    expect(recoveringSeconds(now - 100, now)).toBe(0);
  });
});

describe('ExposureMeter (TASK-52)', () => {
  it('unmounts (renders null) while clear and not recovering', () => {
    mount();
    expect(container.innerHTML).toBe('');
    setHazardFrame({ exposure: 20 }); // drained but outside any hazard
    mount();
    expect(container.innerHTML).toBe('');
  });

  it('renders the #hazard-hud vertical bar with the radiation icon in a rad zone', () => {
    setHazardFrame({ exposure: 40, inside: 'radzone' });
    mount();
    expect(container.innerHTML).toContain('id="hazard-hud"');
    expect(container.innerHTML).toContain('☢');
    expect(container.innerHTML).not.toContain('⚡');
    // Green band (> 25) + the bar reflects exposure (height fraction).
    expect(container.innerHTML).toContain('#4ade80');
    expect(container.innerHTML).toContain(`height: ${(40 / EXPOSURE_MAX) * 100}%`);
    expect(container.innerHTML).toContain('40/50');
    expect(container.innerHTML).not.toContain('RECOVERING');
  });

  it('renders the storm icon in a storm (amber band at 25)', () => {
    setHazardFrame({ exposure: 25, inside: 'storm' });
    mount();
    expect(container.innerHTML).toContain('⚡');
    expect(container.innerHTML).not.toContain('☢');
    expect(container.innerHTML).toContain('#f59e0b');
  });

  it('turns red and pulses below 10', () => {
    setHazardFrame({ exposure: 5, inside: 'radzone' });
    mount();
    expect(container.innerHTML).toContain('#ef4444');
    expect(container.innerHTML).toContain('hazard-hud-pulse');
  });

  it('RECOVERING: frozen red pulsing bar + 5 s countdown (fake timers)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setHazardFrame({ exposure: 0, recoveringUntil: Date.now() + 5_000 });
    mount();
    expect(container.innerHTML).toContain('RECOVERING 5s');
    expect(container.innerHTML).toContain('#ef4444');
    expect(container.innerHTML).toContain('hazard-hud-pulse');
    // The bar is FROZEN at the 0 value (no regen while recovering).
    expect(container.innerHTML).toContain('height: 0%');

    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    expect(container.innerHTML).toContain('RECOVERING 3s'); // ceil(2.4 s)

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(container.innerHTML).toContain('RECOVERING 0s'); // clamped at 0

    // A frame without the deadline ends the knock-down state.
    act(() => {
      setHazardFrame({ exposure: 0 });
    });
    expect(container.innerHTML).not.toContain('RECOVERING');
  });
});
