import React from 'react';

import { hazardState, hazardStateSubscribe } from '@client/state/hazards';
import { EXPOSURE_MAX } from '@shared/world/hazards';

/**
 * Hazard HUD (TASK-48.2) — the #hazard-hud panel (bottom-left): a radiation
 * icon + a bar filled by exposure/EXPOSURE_MAX, shown while the player
 * stands in a drain hazard (the radiation meter) or is knocked down. The
 * bar/icon pulse red as exposure nears 0; the 'SHIELD BURN' / 'RECOVERING'
 * prompt shows for the 5 s knock-down. Players do NOT have on-foot HP in
 * v1 — the panel never shows death, and no death/HP slot exists here
 * (the radiation meter slot is reusable by TASK-52).
 *
 * Driven by state/hazards (the server's per-connection 'hazard' frame —
 * the client only renders; all pool math is server-side). Purely cosmetic;
 * unmounted (null) while clear + not recovering, same idiom as
 * DockedIndicator.
 */

/** Below this exposure the bar + icon turn red AND pulse (the "near 0" band). */
export const HAZARD_PULSE_BELOW = 10;
/** Below this exposure the bar turns amber (the "warning" band). */
export const HAZARD_WARN_BELOW = 25;

/** Pure bar/icon color for an exposure value (testable without a DOM). */
export function hazardBarColor(exposure: number): string {
  if (exposure <= HAZARD_PULSE_BELOW) return '#ef4444'; // red, near 0
  if (exposure <= HAZARD_WARN_BELOW) return '#f59e0b'; // amber warning band
  return '#67e8f9'; // default
}

/** Pure pulse predicate: red pulsing while exposure nears 0. */
export function hazardPulsing(exposure: number): boolean {
  return exposure <= HAZARD_PULSE_BELOW;
}

function useHazard() {
  const [state, setState] = React.useState(hazardState); // lazy init: current value
  React.useEffect(() => hazardStateSubscribe(setState), []);
  return state;
}

const BAR_WIDTH_PX = 120;

export function HazardHud(): React.ReactElement | null {
  const { exposure, inside, recovering } = useHazard();
  if (inside === null && !recovering) return null;
  const fraction = Math.max(0, Math.min(1, exposure / EXPOSURE_MAX));
  const pulsing = hazardPulsing(exposure);
  const color = hazardBarColor(exposure);
  const pulseStyle: React.CSSProperties | undefined = pulsing
    ? { animation: 'hazard-hud-pulse 0.8s ease-in-out infinite' }
    : undefined;
  return (
    <div
      id="hazard-hud"
      role="status"
      aria-label={`exposure ${exposure} of ${EXPOSURE_MAX}`}
      style={{
        position: 'fixed',
        bottom: '2rem',
        left: '2rem',
        zIndex: 85, // above canvas (0) + re-entry tint (80); below the star chart (90)
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.7rem',
        color: '#9fb0c3',
        pointerEvents: 'none',
      }}
    >
      {pulsing && (
        <style>
          {'@keyframes hazard-hud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }'}
        </style>
      )}
      <div style={{ marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden style={{ color, ...pulseStyle }}>
          ☢
        </span>
        <span>
          {Math.round(exposure)}/{EXPOSURE_MAX}
        </span>
      </div>
      <div
        style={{
          width: BAR_WIDTH_PX,
          height: 8,
          border: '1px solid #2a3a4d',
          borderRadius: 3,
          background: 'rgba(17, 21, 31, 0.85)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${fraction * 100}%`,
            height: '100%',
            background: color,
            ...pulseStyle,
            transition: 'width 120ms linear, background 120ms linear',
          }}
        />
      </div>
      {recovering && (
        <div
          style={{
            marginTop: 4,
            color: '#f87171',
            letterSpacing: '0.12em',
            ...pulseStyle,
          }}
        >
          SHIELD BURN — RECOVERING
        </div>
      )}
    </div>
  );
}
