import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { EXPOSURE_MAX } from '@shared/world/hazards';

import { __resetHazards, setHazardFrame } from '@client/state/hazards';

import { HazardHud, hazardBarColor, hazardPulsing } from './hazard-hud';

describe('hazard helpers (TASK-48.2)', () => {
  it('bar color: default high, amber in the warning band, red near 0', () => {
    expect(hazardBarColor(50)).toBe('#67e8f9');
    expect(hazardBarColor(25)).toBe('#f59e0b');
    expect(hazardBarColor(10)).toBe('#ef4444');
    expect(hazardBarColor(0)).toBe('#ef4444');
  });

  it('pulses only while exposure nears 0', () => {
    expect(hazardPulsing(EXPOSURE_MAX)).toBe(false);
    expect(hazardPulsing(11)).toBe(false);
    expect(hazardPulsing(10)).toBe(true);
    expect(hazardPulsing(0)).toBe(true);
  });
});

describe('HazardHud (TASK-48.2)', () => {
  beforeEach(() => __resetHazards());

  it('unmounts (renders null) while clear and not recovering', () => {
    expect(renderToStaticMarkup(<HazardHud />)).toBe('');
    setHazardFrame({ exposure: 20 }); // drained but OUTSIDE any hazard + not recovering
    expect(renderToStaticMarkup(<HazardHud />)).toBe('');
  });

  it('renders #hazard-hud with the radiation icon + a bar sized to exposure when inside', () => {
    setHazardFrame({ exposure: 25, inside: 'storm' });
    const html = renderToStaticMarkup(<HazardHud />);
    expect(html).toContain('id="hazard-hud"');
    expect(html).toContain('role="status"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('ui-monospace');
    expect(html).toContain('☢'); // radiation icon
    expect(html).toContain(`width:${(25 / EXPOSURE_MAX) * 100}%`); // bar reflects exposure
    expect(html).toContain('25/50');
    expect(html).not.toContain('SHIELD BURN'); // no knock-down prompt
  });

  it('pulses red as exposure nears 0', () => {
    setHazardFrame({ exposure: 5, inside: 'radzone' });
    const html = renderToStaticMarkup(<HazardHud />);
    expect(html).toContain('#ef4444'); // red
    expect(html).toContain('hazard-hud-pulse'); // pulsing animation
    expect(html).toContain('@keyframes hazard-hud-pulse');
  });

  it("shows the 'SHIELD BURN' / 'RECOVERING' prompts while recovering", () => {
    setHazardFrame({ exposure: 0, recoveringUntil: Date.now() + 5_000 });
    const html = renderToStaticMarkup(<HazardHud />);
    expect(html).toContain('SHIELD BURN');
    expect(html).toContain('RECOVERING');
  });
});
