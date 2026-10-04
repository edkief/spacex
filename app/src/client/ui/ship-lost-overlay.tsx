import React from 'react';

import {
  SHIP_LOST_MS,
  hideShipLost,
  shipLostCurrent,
  shipLostSubscribe,
  type ShipLostMoment,
} from '@client/state/ship-lost';

/**
 * The 'SHIP LOST' full-screen moment (TASK-49) — shown for 2 s when the
 * player's own ship is destroyed: the callsign, the killer, and the
 * respawn note. Pure presentation: the respawn itself is server-side and
 * immediate (nearest dock, starter scout), the moment just covers the
 * frame where the cockpit would pop.
 *
 * Styling mirrors the warp overlay (fixed full-screen layer, no pointer
 * capture, a fade-in / fade-out keyframe pair).
 */

export function ShipLostOverlay(): React.ReactElement | null {
  const [moment, setMoment] = React.useState<ShipLostMoment | null>(shipLostCurrent);
  React.useEffect(() => shipLostSubscribe(setMoment), []);
  // The moment is fixed-length: a 2 s timer from each `showShipLost`.
  React.useEffect(() => {
    if (!moment) return;
    const t = window.setTimeout(() => hideShipLost(), SHIP_LOST_MS);
    return () => window.clearTimeout(t);
  }, [moment]);
  if (!moment) return null;
  return (
    <div id="ship-lost" role="alert" style={overlayBase}>
      <style>{css}</style>
      <div className="ship-lost-inner">
        <div className="ship-lost-title">SHIP LOST</div>
        <div className="ship-lost-callsign">{moment.callsign}</div>
        <div className="ship-lost-killer">Killed by {moment.killer}</div>
        <div className="ship-lost-respawn">Respawning at nearest dock</div>
      </div>
    </div>
  );
}

const overlayBase: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 85, // above the warp overlay (80), below the star chart panel (90)
  overflow: 'hidden',
  opacity: 0,
  animation: `ship-lost-in ${SHIP_LOST_MS}ms linear forwards`,
};

const css = `
@keyframes ship-lost-in {
  from { opacity: 0; }
  30%  { opacity: 1; }
  85%  { opacity: 1; }
  to   { opacity: 0; }
}
#ship-lost .ship-lost-inner {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  background: radial-gradient(circle at 50% 50%,
    rgba(60, 8, 8, 0.55) 0%,
    rgba(10, 4, 4, 0.75) 55%,
    rgba(0, 0, 0, 0.35) 100%);
  color: #e8e2dc;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: center;
}
#ship-lost .ship-lost-title {
  font-size: 3rem;
  font-weight: 700;
  letter-spacing: 0.3em;
  color: #ff6b57;
  text-shadow: 0 0 18px rgba(255, 90, 60, 0.6);
}
#ship-lost .ship-lost-callsign {
  font-size: 1.2rem;
  letter-spacing: 0.12em;
  color: #d6deeb;
}
#ship-lost .ship-lost-killer {
  font-size: 0.9rem;
  letter-spacing: 0.08em;
  color: #ffb3a7;
}
#ship-lost .ship-lost-respawn {
  margin-top: 1rem;
  font-size: 0.8rem;
  letter-spacing: 0.08em;
  color: #9fb0c8;
}
`;
