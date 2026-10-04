// @vitest-environment happy-dom
/**
 * TASK-50: combat HUD component tests — layout disjointness at the 1280×720
 * reference viewport (the spec's bounding-box disjointness, computed from
 * the SAME slot functions that generate the inline styles — the browser
 * layout would differ only in sub-pixel rounding, and the slots are all
 * fixed px), the energy bar states, the threat-ping bearing→wedge rotation
 * and opacity, and the target box (AI tag, live distance, lock indicator,
 * > 1500 m hide, bracket projection).
 *
 * Live rendering (createRoot + act, happy-dom) so the store subscriptions
 * (10 Hz cadence) run — static markup cannot drive them.
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
  toggleTargetLock,
} from '@client/state/targeting';
import { frameMonitor } from '@client/perf/frameMonitor';

import {
  HUD_BUDGET_MS,
  allPairwiseDisjoint,
  combatHudRects,
  protectedRects,
  targetBoxRect,
  threatPingRect,
  weaponReadoutRect,
  type Viewport,
} from './layout';
import { energyBarColor, WeaponReadout } from './weapon-readout';
import { TargetBox, TARGET_BOX_RANGE_M } from './target-box';
import { ThreatPing } from './threat-ping';
import { CombatHud } from './combat-hud';

const VP: Viewport = { w: 1_280, h: 720 };
const NO_CAMERA = () => null;

let roots: Root[] = [];

/** Render with effects (subscriptions + rAF), return the container. */
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
  frameMonitor.reset();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

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

/** Self at origin (nose +Z) + a target `dist` m dead ahead. */
function worldWith(dist: number, targetExtra: Partial<EntityState> = {}): EntityState[] {
  return [
    mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
    mk(
      'ai:dummy:1',
      'ai-ship',
      { x: 0, y: 0, z: dist },
      {
        callsign: 'AI-001-1',
        hull: 0.61,
        shields: 0.2,
        ...targetExtra,
      },
    ),
  ];
}

function lockTarget(dist = 200, targetExtra: Partial<EntityState> = {}): void {
  const now = Date.now();
  ingestTargetingEntities(worldWith(dist, targetExtra), 'one', now, 'p1');
  toggleTargetLock(now);
  ingestTargetingEntities(worldWith(dist, targetExtra), 'one', now, 'p1');
}

describe('layout disjointness (1280×720, threat ping at bearing +90°)', () => {
  const all = {
    ...combatHudRects(VP, Math.PI / 2),
    ...protectedRects(VP),
  };

  it('every HUD region is pairwise disjoint (combat + protected)', () => {
    expect(Object.keys(all)).toEqual([
      'targetBox',
      'weaponReadout',
      'threatPing',
      'killFeed',
      'targetBanner',
      'chat',
      'playerList',
      'promptLine',
      'debugOverlay',
    ]);
    expect(allPairwiseDisjoint(all)).toBe(true);
  });

  it('the slots match the spec positions', () => {
    const box = targetBoxRect(VP);
    // Right of center, 1/3 from the right edge.
    expect(box.x).toBeCloseTo((VP.w * 2) / 3, 6);
    expect(box.x).toBeGreaterThan(VP.w / 2);
    const wr = weaponReadoutRect(VP);
    // Bottom-center, above the prompt line (which starts at h − 72).
    expect(wr.x).toBeCloseTo((VP.w - wr.w) / 2, 6);
    expect(wr.y + wr.h).toBeLessThanOrEqual(VP.h - 72);
    // The threat ping rides the edge ring (its center at the ring radius).
    const tp = threatPingRect(Math.PI / 2, VP);
    const ring = Math.min(VP.w, VP.h) / 2 - 120;
    expect(tp.x + tp.w / 2).toBeCloseTo(VP.w / 2 + ring, 6);
    expect(tp.y + tp.h / 2).toBeCloseTo(VP.h / 2, 6);
  });
});

describe('WeaponReadout', () => {
  const base = {
    viewport: VP,
    classId: 'scout' as string | null,
    energy: 100,
    weapon: 'laser' as const,
    onWeapon: () => {},
    lowEnergy: false,
    locked: false,
  };

  it('renders the active weapon + energy value (the weapons e2e contract)', () => {
    const html = renderWithEffects(<WeaponReadout {...base} />).innerHTML;
    expect(html).toContain('id="weapon-hud"');
    expect(html).toContain('LASER');
    expect(html).toContain('100/100');
  });

  it('energy bar states: blue ≥ 25, amber < 25, red < 10 (+ LOW ENERGY)', () => {
    expect(energyBarColor(100)).toBe('#5cb8e0');
    expect(energyBarColor(25)).toBe('#5cb8e0');
    expect(energyBarColor(24.9)).toBe('#ffd23f');
    expect(energyBarColor(9.9)).toBe('#e05c42');

    // Assert on the DOM style (the bar's inline background-color).
    const barColor = (el: HTMLDivElement) =>
      (el.querySelector('[data-testid="energy-bar"]') as HTMLElement).style.backgroundColor;
    const amber = renderWithEffects(<WeaponReadout {...base} energy={20} />);
    expect(barColor(amber).toLowerCase()).toBe('#ffd23f');
    expect(amber.innerHTML).not.toContain('data-testid="low-energy"');

    const red = renderWithEffects(<WeaponReadout {...base} energy={5} />);
    expect(barColor(red).toLowerCase()).toBe('#e05c42');
    expect(red.innerHTML).toContain('data-testid="low-energy"');
    expect(red.innerHTML).toContain('LOW ENERGY');
  });

  it('shows loadout counts (interceptor dual lasers) + the missile count', () => {
    const html = renderWithEffects(<WeaponReadout {...base} classId="interceptor" />).innerHTML;
    expect(html).toContain('1 LASER ×2');
    expect(html).toContain('2 MISSILE ×4');
    const missile = renderWithEffects(
      <WeaponReadout {...base} classId="interceptor" weapon="missile" />,
    ).innerHTML;
    expect(missile).toContain('MISSILE');
    expect(missile).toContain('data-testid="missile-count"');
    expect(missile).toContain('×4');
  });

  it('is null on foot (no ship class)', () => {
    expect(renderWithEffects(<WeaponReadout {...base} classId={null} />).innerHTML).toBe('');
  });

  it('shows the server denial prompts when set', () => {
    const html = renderWithEffects(<WeaponReadout {...base} lowEnergy locked />).innerHTML;
    expect(html).toContain('LOW ENERGY');
    expect(html).toContain('WEAPON LOCKED');
  });
});

describe('ThreatPing', () => {
  // The store resolves the attacker via id OR callsign (the event's source
  // id is the attacker's callsign on the wire) — the 2nd test's entity
  // carries callsign 'ATT', so the bearing resolves against it.
  const HIT: CombatEvent = {
    kind: 'hit',
    target: 'ship-p1',
    source: { kind: 'player', id: 'ATT' },
    weapon: 'laser',
    damage: 8,
    shieldHit: 8,
    hullHit: 0,
  };

  it('renders nothing while no threat is lit', () => {
    ingestTargetingEntities(worldWith(200), 'one', Date.now());
    expect(renderWithEffects(<ThreatPing viewport={VP} />).innerHTML).toBe('');
  });

  it('renders the edge wedge: full opacity on a fresh 3 s hit', () => {
    const now = Date.now();
    ingestTargetingEntities(worldWith(200), 'one', now);
    ingestCombatEvent(HIT, 'p1', now);
    const el = renderWithEffects(<ThreatPing viewport={VP} />);
    expect(el.innerHTML).toContain('id="threat-ping"');
    expect(el.innerHTML).toContain('data-testid="threat-ping-wedge"');
    // Attacker id not in the snapshot → the arc keeps bearing 0 (dead ahead)
    // → rotate(0deg), and the wedge carries the conic-gradient fill.
    expect(el.innerHTML).toContain('rotate(0deg)');
    expect(el.innerHTML).toContain('conic-gradient');
    const m = el.innerHTML.match(/opacity:\s*(0?\.\d+|1)/);
    expect(parseFloat(m![1])).toBeGreaterThan(0.9);
  });

  it('rotates the wedge by the attacker bearing (right = positive deg)', () => {
    const now = Date.now();
    // Attacker 90° to the right (nose +Z → +X is right).
    ingestTargetingEntities(
      [
        mk('ship-p1', 'ship', { x: 0, y: 0, z: 0 }, { callsign: 'one' }),
        mk('ship-p2', 'ship', { x: 100, y: 0, z: 0 }, { callsign: 'ATT' }),
      ],
      'one',
      now,
    );
    ingestCombatEvent(HIT, 'p1', now);
    const html = renderWithEffects(<ThreatPing viewport={VP} />).innerHTML;
    // +90° bearing → clockwise 90° rotation.
    expect(html).toMatch(/rotate\(90(\.\d+)?deg\)/);
  });
});

describe('TargetBox', () => {
  it('renders the card: callsign, AI tag, live distance, hull/shield bars', () => {
    lockTarget();
    const el = renderWithEffects(<TargetBox viewport={VP} camera={NO_CAMERA} />);
    const html = el.innerHTML;
    expect(html).toContain('id="target-box"');
    expect(html).toContain('AI-001-1');
    expect(html).toContain('data-testid="target-ai-tag"');
    expect(html).toContain('200 m');
    expect(html).toContain('HULL');
    expect(html).toContain('SHLD');
    // The card sits in its fixed slot (the layout module's rect → inline
    // style; the DOM truncates px to 6 decimals, so compare numerically).
    const slot = targetBoxRect(VP);
    const card = el.querySelector('#target-box') as HTMLElement;
    expect(parseFloat(card.style.left)).toBeCloseTo(slot.x, 2);
    expect(parseFloat(card.style.top)).toBeCloseTo(slot.y, 2);
    expect(parseFloat(card.style.width)).toBeCloseTo(slot.w, 2);
    expect(parseFloat(card.style.height)).toBeCloseTo(slot.h, 2);
    // The bracket is present but hidden until the first rAF projection.
    expect(html).toContain('id="target-bracket"');
  });

  it('tracks the projection every frame (rAF writes the ref’d style)', async () => {
    lockTarget();
    // Chase camera 100 m BEHIND the target facing +Z (180° yaw): the target
    // at z=200, 300 m dead ahead, projects to screen center (1000×1000, 90°).
    const el = renderWithEffects(
      <TargetBox
        viewport={VP}
        camera={() => ({
          pos: { x: 0, y: 0, z: -100 },
          quat: { x: 0, y: 1, z: 0, w: 0 }, // forward = +Z
          fovDeg: 90,
          width: 1_000,
          height: 1_000,
        })}
      />,
    );
    await new Promise((r) => setTimeout(r, 50)); // let an rAF tick run
    const bracket = el.querySelector('#target-bracket') as HTMLElement;
    expect(bracket.style.display).toBe('block');
    // translate(center − bracket/2) = (500−32, 500−22).
    expect(bracket.style.transform).toContain('translate(468px, 478px)');
  });

  it('hides the bracket when the target is behind the camera', async () => {
    lockTarget();
    // Camera BEHIND the target (z=400) facing +Z (180° yaw) → the target at
    // z=200 is behind the camera plane.
    const el = renderWithEffects(
      <TargetBox
        viewport={VP}
        camera={() => ({
          pos: { x: 0, y: 0, z: 400 },
          quat: { x: 0, y: 1, z: 0, w: 0 }, // 180° about +Y → forward = +Z
          fovDeg: 90,
          width: 1_000,
          height: 1_000,
        })}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    // Behind the camera → the whole box (bracket AND card) is hidden.
    expect(el.querySelector('#target-bracket')).toBeNull();
    expect(el.querySelector('#target-box')).toBeNull();
  });

  it('hides the whole box beyond 1500 m', () => {
    lockTarget(TARGET_BOX_RANGE_M + 1);
    expect(renderWithEffects(<TargetBox viewport={VP} camera={NO_CAMERA} />).innerHTML).toBe('');
  });

  it('shows the weapon-locked indicator when the target locked the player', () => {
    lockTarget(200, { targetedBy: ['p1'] });
    const html = renderWithEffects(<TargetBox viewport={VP} camera={NO_CAMERA} />).innerHTML;
    expect(html).toContain('data-testid="target-locks-us"');
    expect(html).toContain('LOCKED ON');
  });

  it('no box → nothing renders', () => {
    ingestTargetingEntities(worldWith(200), 'one', Date.now());
    expect(renderWithEffects(<TargetBox viewport={VP} camera={NO_CAMERA} />).innerHTML).toBe('');
  });
});

describe('CombatHud assembly', () => {
  it('mounts the four regions in one tree', () => {
    lockTarget();
    const html = renderWithEffects(
      <CombatHud
        viewport={VP}
        camera={NO_CAMERA}
        classId="scout"
        energy={80}
        weapon="laser"
        onWeapon={() => {}}
        lowEnergy={false}
        locked={false}
      />,
    ).innerHTML;
    for (const id of ['target-box', 'weapon-hud', 'kill-feed']) {
      expect(html).toContain(`id="${id}"`);
    }
    // The 'hud' frame budget is registered (the AC's < 1 ms bound).
    expect(frameMonitor.getBudgetStats('hud').budgetMs).toBe(HUD_BUDGET_MS);
  });

  it('the per-frame projection stays under the hud budget (no warnings)', async () => {
    lockTarget();
    const el = renderWithEffects(
      <CombatHud
        viewport={VP}
        camera={() => ({
          pos: { x: 0, y: 0, z: -100 },
          quat: quatIdentity(),
          fovDeg: 90,
          width: 1_280,
          height: 720,
        })}
        classId="scout"
        energy={80}
        weapon="laser"
        onWeapon={() => {}}
        lowEnergy={false}
        locked={false}
      />,
    );
    void el;
    await new Promise((r) => setTimeout(r, 100)); // several rAF ticks
    const stats = frameMonitor.getBudgetStats('hud');
    expect(stats.budgetMs).toBe(HUD_BUDGET_MS);
    expect(stats.maxMs).toBeLessThan(HUD_BUDGET_MS);
    expect(stats.warnings).toBe(0);
  });
});
