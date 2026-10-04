/**
 * TASK-50: the COMBAT HUD — assembles the four combat regions in their
 * fixed layout slots (layout.ts is the single source of truth for the
 * geometry the layout disjointness test asserts):
 *
 *   target box (bracket + card)  — right of center, tracks the projection
 *   weapon readout               — bottom-center, above the prompt line
 *   threat ping                  — screen-edge wedge, last-attacker bearing
 *   kill feed (TASK-47)          — top-center, 5 entries / 10 s
 *
 * Everything updates at the 10 Hz snapshot cadence; the ONLY per-frame work
 * is the target-bracket projection (a ref'd style write, timed into the
 * frame monitor's 'hud' budget, 1 ms).
 */
import React from 'react';
import type { WeaponId } from '@shared/weapons';
import { frameMonitor } from '@client/perf/frameMonitor';
import { targetingSubscribe, type TargetingView } from '@client/state/targeting';
import { KillFeed } from '@client/hud/kill-feed';
import { TargetBox } from './target-box';
import { ThreatPing } from './threat-ping';
import { WeaponReadout } from './weapon-readout';
import {
  HUD_BUDGET_MS,
  styleFromRect,
  targetBannerRect,
  type Viewport,
} from './layout';

/** The transient banner window (the store's self-clear is 2.5 s). */
const BANNER_MS = 2_500;
/** The 'NO TARGET' missile-denial prompt window. */
const NO_TARGET_MS = 1_500;

export interface CombatHudProps {
  viewport: Viewport;
  camera: () => import('./projection').CameraSample | null;
  classId: string | null;
  energy: number | null;
  weapon: WeaponId;
  onWeapon: (weapon: WeaponId) => void;
  lowEnergy: boolean;
  locked: boolean;
}

export function CombatHud(props: CombatHudProps) {
  React.useEffect(() => {
    frameMonitor.registerBudget('hud', HUD_BUDGET_MS);
  }, []);
  return (
    <>
      <TargetBox viewport={props.viewport} camera={props.camera} />
      <TargetBanner viewport={props.viewport} />
      <WeaponReadout
        viewport={props.viewport}
        classId={props.classId}
        energy={props.energy}
        weapon={props.weapon}
        onWeapon={props.onWeapon}
        lowEnergy={props.lowEnergy}
        locked={props.locked}
      />
      <ThreatPing viewport={props.viewport} />
      <KillFeed />
    </>
  );
}

/** The transient 'TARGET LOCKED' banner + 'NO TARGET' denial prompt. */
function TargetBanner({ viewport }: { viewport: Viewport }) {
  const [view, setView] = React.useState<TargetingView | null>(null);
  React.useEffect(() => targetingSubscribe(setView), []);
  const [now, setNow] = React.useState(() => Date.now());
  const bannerAlive = !!(view?.banner && now - view.banner.atMs < BANNER_MS);
  const noTargetAlive = !!view && view.noTargetAt > 0 && now - view.noTargetAt < NO_TARGET_MS;
  React.useEffect(() => {
    if (!bannerAlive && !noTargetAlive) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [bannerAlive, noTargetAlive]);

  if (!bannerAlive && !noTargetAlive) return null;
  return (
    <div
      role="status"
      style={styleFromRect(targetBannerRect(viewport), {
        zIndex: 96,
        pointerEvents: 'none',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: 'rgba(10, 14, 22, 0.62)',
        border: '1px solid rgba(120, 140, 170, 0.45)',
      })}
    >
      {bannerAlive && view?.banner ? (
        <div id="target-locked-banner" style={{ color: '#ffd23f' }}>
          {view.banner.text}
        </div>
      ) : (
        <div id="no-target-prompt" style={{ color: '#ff5a5a' }}>
          NO TARGET
        </div>
      )}
    </div>
  );
}
