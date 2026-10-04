/**
 * TASK-50: the THREAT PING — a red arc (a conic-gradient wedge, a DOM
 * element at the SCREEN EDGE, not world-anchored) pointing at the last
 * attacker's bearing (TASK-44 state), fading out over its 3 s life.
 * 10 Hz state cadence (snapshot-driven); the wedge's slot comes from the
 * shared layout module so the layout test sees exactly this geometry.
 */
import React from 'react';
import { targetingSubscribe, type TargetingView } from '@client/state/targeting';
import { styleFromRect, threatPingRect, type Viewport } from './layout';

/** Fade window: opacity = remaining ms / this. */
export const THREAT_PING_FADE_MS = 3_000;
/** The 10 Hz clock that ages the fade (the snapshot cadence). */
const TICK_MS = 100;

export interface ThreatPingProps {
  viewport: Viewport;
}

export function ThreatPing({ viewport }: ThreatPingProps) {
  const [view, setView] = React.useState<TargetingView | null>(null);
  React.useEffect(() => targetingSubscribe(setView), []);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const threat = view?.threat;
  const remaining = threat ? threat.expiresAt - now : 0;
  if (!threat || remaining <= 0) return null;

  const bearingDeg = (threat.bearing * 180) / Math.PI;
  return (
    <div
      id="threat-ping"
      role="status"
      data-testid="threat-ping"
      title={threat.attackerId}
      style={styleFromRect(threatPingRect(threat.bearing, viewport), {
        zIndex: 94,
        pointerEvents: 'none',
        opacity: Math.max(0, remaining / THREAT_PING_FADE_MS),
      })}
    >
      {/* The wedge: a pie slice pointing AWAY from screen center; the
          element sits on the ring, so "up" (12 o'clock) is outward and a
          clockwise rotation by the (screen-mapped) bearing points it at
          the attacker. */}
      <div
        data-testid="threat-ping-wedge"
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          transform: `rotate(${bearingDeg}deg)`,
          background:
            'conic-gradient(from -32deg at 50% 50%, rgba(255, 45, 45, 0.95) 0deg 64deg, transparent 64deg 360deg)',
        }}
      />
    </div>
  );
}
