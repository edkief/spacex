import React from 'react';

import { hazardState, hazardStateSubscribe } from '@client/state/hazards';
import { EXPOSURE_MAX } from '@shared/world/hazards';

/**
 * Exposure meter (TASK-52) — the on-foot radiation/shield meter, bottom-RIGHT
 * above the weight bar (a vertical 50-max bar). Filled by exposure/EXPOSURE_MAX
 * (it shrinks as exposure is lost); green > 25, amber 10-25, red < 10.
 * A radiation icon (☢) while inside a rad zone, a storm icon (⚡) in a storm.
 * The 5 s knock-down renders the 'RECOVERING' state: the bar is FROZEN
 * (the server holds exposure at 0 while recovering — the meter shows the
 * frozen value), pulses red, and counts down the remaining seconds from the
 * server's `recoveringUntil` deadline (a 250 ms local tick — pure cosmetics,
 * the deadline itself is server truth).
 *
 * Driven ONLY by state/hazards (the server's per-connection 10 Hz 'hazard'
 * frame) — the client runs zero exposure math. Keeps the TASK-48.2 `#hazard-hud`
 * id (the e2e specs + debug hook assert it).
 */

/** Below this exposure the bar is red (the "critical" band). */
export const EXPOSURE_CRIT_BELOW = 10;
/** At or below this exposure the bar is amber (the "warning" band). */
export const EXPOSURE_WARN_AT = 25;

/** Pure bar color (AC: green > 25, amber 10-25, red < 10). */
export function exposureColor(exposure: number): string {
  if (exposure < EXPOSURE_CRIT_BELOW) return '#ef4444'; // red, critical
  if (exposure <= EXPOSURE_WARN_AT) return '#f59e0b'; // amber warning band
  return '#4ade80'; // green
}

/** The icon for the active hazard kind (null when clear). */
export function exposureIcon(inside: 'storm' | 'radzone' | null): string | null {
  if (inside === 'radzone') return '☢';
  if (inside === 'storm') return '⚡';
  return null;
}

/** Pure countdown: whole seconds remaining until the knock-down ends (≥ 0). */
export function recoveringSeconds(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** The local tick that refreshes the countdown while recovering (cosmetic). */
const COUNTDOWN_TICK_MS = 250;

const BAR_HEIGHT_PX = 72;

function useHazard() {
  const [state, setState] = React.useState(hazardState); // lazy init: current value
  React.useEffect(() => hazardStateSubscribe(setState), []);
  return state;
}

export function ExposureMeter(): React.ReactElement | null {
  const { exposure, inside, recovering, recoveringUntil } = useHazard();
  // The countdown label: the deadline is server truth; a 250 ms tick only
  // re-renders the label while recovering (no tick otherwise — zero cost).
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!recovering) return undefined;
    const t = window.setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(t);
  }, [recovering]);

  if (inside === null && !recovering) return null;
  const frozen = recovering; // RECOVERING: the bar holds its (0) value
  const fraction = frozen ? 0 : Math.max(0, Math.min(1, exposure / EXPOSURE_MAX));
  const color = frozen ? '#ef4444' : exposureColor(exposure);
  const pulsing = frozen || exposure < EXPOSURE_CRIT_BELOW;
  const pulseStyle: React.CSSProperties | undefined = pulsing
    ? { animation: 'hazard-hud-pulse 0.8s ease-in-out infinite' }
    : undefined;
  const icon = recovering ? null : exposureIcon(inside);
  return (
    <div
      id="hazard-hud"
      role="status"
      aria-label={`exposure ${Math.round(exposure)} of ${EXPOSURE_MAX}`}
      style={{
        position: 'fixed',
        bottom: '4.8rem', // above the weight bar (bottom 2rem)
        right: '2rem',
        zIndex: 85, // above canvas (0) + re-entry tint (80); below the star chart (90)
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.7rem',
        color: '#9fb0c3',
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
      }}
    >
      {pulsing && (
        <style>
          {'@keyframes hazard-hud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }'}
        </style>
      )}
      {icon && (
        <span aria-hidden style={{ color, ...pulseStyle }}>
          {icon}
        </span>
      )}
      {/* The vertical 50-max bar (fills bottom-up with remaining exposure). */}
      <div
        style={{
          width: 10,
          height: BAR_HEIGHT_PX,
          border: '1px solid #2a3a4d',
          borderRadius: 3,
          background: 'rgba(17, 21, 31, 0.85)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
        }}
      >
        <div
          style={{
            width: '100%',
            height: `${fraction * 100}%`,
            background: color,
            ...pulseStyle,
            transition: 'height 120ms linear, background 120ms linear',
          }}
        />
      </div>
      <span style={pulseStyle}>
        {Math.round(exposure)}/{EXPOSURE_MAX}
      </span>
      {recovering && recoveringUntil !== null && (
        <span
          style={{
            color: '#f87171',
            letterSpacing: '0.12em',
            ...pulseStyle,
          }}
        >
          RECOVERING {recoveringSeconds(recoveringUntil, nowMs)}s
        </span>
      )}
    </div>
  );
}
