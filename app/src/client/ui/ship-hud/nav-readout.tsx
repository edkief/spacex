/**
 * Nav readout (TASK-51) — the bridge between the chart and flight: a
 * bearing arrow + distance toward the nav target.
 *
 * Target priority: the chart selection (state/chart-target — interstellar,
 * shown as '→ NAME · WARP', no in-system bearing exists for another star)
 * else the implicit dock target (the nearest station, always available —
 * supplied by the caller as a world position + name).
 *
 * Performance (spec): React re-renders only on target presence changes
 * (chart selection / dock availability); the ONLY per-frame work is the
 * chevron's ref'd style transform + the distance ref's textContent (a raw
 * DOM write, not a React render) — the rAF loop reads the LIVE ship
 * attitude (the predictor's pose at render rate) so the arrow tracks the
 * chase camera's smooth turns. The chevron lifts with the target's
 * elevation (the above/below component, meaningful in space).
 */
import React from 'react';
import type { Quat, Vec3 } from '@shared/protocol/schemas';
import { chartTargetSubscribe } from '@client/state/chart-target';
import { vecSub, vecLength } from '@shared/physics/vec';
import { elevLiftPx, bearingTo, formatDistanceM } from './nav-math';

/** Max chevron lift (px) for a straight-up / straight-down target. */
const MAX_LIFT_PX = 16;

export interface NavSample {
  pos: Vec3;
  rot: Quat;
}

export interface DockTarget {
  name: string;
  pos: Vec3;
}

export interface NavReadoutProps {
  /** The live (predicted) self-ship pose at render rate; null = no ship. */
  sample: () => NavSample | null;
  /** The implicit dock target (nearest station) or null. */
  dockTarget: () => DockTarget | null;
}

function initialDistance(sample: () => NavSample | null, dock: DockTarget | null): string | null {
  const s = sample();
  if (!s || !dock) return null;
  return formatDistanceM(vecLength(vecSub(dock.pos, s.pos)));
}

export function NavReadout(props: NavReadoutProps): React.ReactElement | null {
  const [chart, setChart] = React.useState<{ systemId: string; name: string } | null>(null);
  const [dock, setDock] = React.useState<DockTarget | null>(() => props.dockTarget());
  const chevronRef = React.useRef<HTMLSpanElement>(null);
  const distRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => chartTargetSubscribe(setChart), []);
  // The dock target can only appear/disappear on a world swap — poll cheaply.
  React.useEffect(() => {
    const id = window.setInterval(() => setDock(props.dockTarget()), 250);
    return () => window.clearInterval(id);
  }, [props]);

  React.useEffect(() => {
    if (chart || !dock) return;
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const s = props.sample();
      const el = chevronRef.current;
      if (!s || !el) return;
      const b = bearingTo(s.pos, s.rot, dock.pos);
      el.style.transform = `rotate(${b.yawDeg}deg) translateY(${-elevLiftPx(b.elevRad, MAX_LIFT_PX)}px)`;
      const dist = distRef.current;
      if (dist) dist.textContent = formatDistanceM(b.distM);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [chart, dock, props]);

  // Chart target: interstellar — name only (no bearing to another star).
  if (chart) {
    return (
      <div id="ship-hud-nav">
        <span className="nav-arrow" aria-hidden>
          →
        </span>{' '}
        <span>
          {chart.name} · <em>WARP</em>
        </span>
      </div>
    );
  }
  if (!dock) return null;
  return (
    <div id="ship-hud-nav">
      <span ref={chevronRef} className="nav-arrow" aria-hidden>
        ▲
      </span>{' '}
      <span ref={distRef}>{initialDistance(props.sample, dock) ?? '\u00a0'}</span>
    </div>
  );
}

export const NAV_MAX_LIFT_PX = MAX_LIFT_PX;
