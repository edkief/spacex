// @vitest-environment happy-dom
/**
 * TASK-54: reduced motion — the threat ping renders a STATIC edge icon
 * (constant opacity, no wedge rotation, no fade-out animation) instead of
 * the animated conic wedge; the flag off restores the wedge.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CombatEvent } from '@client/fx';
import type { EntityState } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';
import { quatIdentity } from '@shared/physics/vec';

import {
  __resetTargeting,
  ingestCombatEvent,
  ingestTargetingEntities,
} from '@client/state/targeting';
import { SETTING_KEYS } from '@shared/settings';
import { __resetSettings, setSetting } from '@client/a11y/reduced-motion';

import { ThreatPing } from './threat-ping';

const VP = { w: 1_280, h: 720 };

const mk = (
  id: string,
  kind: EntityState['kind'],
  pos: Vec3,
  extra: Partial<EntityState> = {},
): EntityState =>
  ({
    id,
    kind,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    rot: quatIdentity(),
    regime: 'space',
    hull: 1,
    shields: 1,
    targetId: null,
    classId: 'scout',
    ...extra,
  }) as EntityState;

const HIT: CombatEvent = {
  kind: 'hit',
  target: 'ship-p1',
  source: { kind: 'player', id: 'ATT' },
  weapon: 'laser',
  damage: 8,
  shieldHit: 8,
  hullHit: 0,
};

function lightThreat(): void {
  const now = Date.now();
  ingestTargetingEntities(
    [
      mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
      mk('ship-p2', 'ship', { x: 100, y: 0, z: 0 }, { callsign: 'ATT' }),
    ],
    'one',
    now,
  );
  ingestCombatEvent(HIT, 'p1', now);
}

let roots: Root[] = [];

function renderWithEffects(el: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  roots.push(root);
  return container;
}

beforeEach(() => {
  __resetTargeting();
  __resetSettings();
  lightThreat();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  __resetTargeting();
  __resetSettings();
});

describe('ThreatPing reduced motion (TASK-54)', () => {
  it('renders the animated wedge by default', () => {
    const html = renderWithEffects(<ThreatPing viewport={VP} />).innerHTML;
    expect(html).toContain('data-testid="threat-ping-wedge"');
    expect(html).toContain('conic-gradient');
    expect(html).not.toContain('data-reduced-motion="true"');
  });

  it('reduced motion: a STATIC icon (no wedge, no rotation, constant opacity)', () => {
    setSetting(SETTING_KEYS.reducedMotion, true);
    const el = renderWithEffects(<ThreatPing viewport={VP} />);
    const html = el.innerHTML;
    expect(html).toContain('data-reduced-motion="true"');
    expect(html).toContain('data-testid="threat-ping-static"');
    expect(html).not.toContain('data-testid="threat-ping-wedge"');
    expect(html).not.toContain('conic-gradient');
    expect(html).not.toContain('rotate(');
    // static: no opacity fade at all (the animated wedge carries opacity)
    expect(html).not.toMatch(/opacity:\s*0?\.\d/);
  });

  it('takes effect immediately (no restart): the wedge returns when the flag flips off', () => {
    setSetting(SETTING_KEYS.reducedMotion, true);
    const el = renderWithEffects(<ThreatPing viewport={VP} />);
    expect(el.innerHTML).toContain('data-reduced-motion="true"');
    act(() => setSetting(SETTING_KEYS.reducedMotion, false));
    expect(el.innerHTML).not.toContain('data-reduced-motion="true"');
    expect(el.innerHTML).toContain('data-testid="threat-ping-wedge"');
  });
});
