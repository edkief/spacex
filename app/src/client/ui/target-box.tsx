/**
 * TASK-44 HUD stub: the TARGET BOX (locked ship: callsign, live distance,
 * hull/shield bars, bearing) + the 'TARGET LOCKED' banner + the NO TARGET
 * prompt + the red THREAT PING arc pointing at the strongest recent
 * attacker. TASK-50 replaces this stub with the full ship HUD; the state
 * contract (state/targeting.ts) is what that HUD consumes.
 */

import React from 'react';
import { targetingSubscribe, type TargetingView } from '@client/state/targeting';

const PANEL: React.CSSProperties = {
  position: 'fixed',
  zIndex: 95,
  pointerEvents: 'none',
  fontFamily: 'monospace',
  fontSize: 12,
  color: '#cdd6e4',
  background: 'rgba(10, 14, 22, 0.55)',
  border: '1px solid rgba(120, 140, 170, 0.35)',
  padding: '8px 10px',
};

/** Fresh render every 250 ms while time-based pieces are alive. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function TargetHud() {
  const [v, setV] = React.useState<TargetingView | null>(null);
  React.useEffect(() => targetingSubscribe(setV), []);
  const now = useNow(
    !!(
      (v?.threat && v.threat.expiresAt > Date.now()) ||
      (v?.banner && Date.now() - v.banner.atMs < 2500)
    ),
  );
  if (!v) return null;
  const bannerAlive = v.banner && now - v.banner.atMs < 2500;
  const threatAlive = v.threat && v.threat.expiresAt > now;
  return (
    <>
      {v.box && (
        <div
          id="target-box"
          role="status"
          data-testid="target-box"
          style={{ ...PANEL, top: 96, right: 16, width: 190 }}
        >
          <div style={{ color: '#ff5a5a', letterSpacing: 1 }}>◤ TARGET LOCK ◢</div>
          <div style={{ margin: '4px 0', color: '#ffffff' }}>{v.box.callsign}</div>
          <div>
            {Math.round(v.box.distance)} m BRG {((v.box.bearing * 180) / Math.PI).toFixed(0)}°
          </div>
          <div>
            HULL <Bar pct={v.box.hullPct} color="#5ad17a" />
            {v.box.hullPct}%
          </div>
          <div>
            SHLD <Bar pct={v.box.shieldPct} color="#5a9bd1" />
            {v.box.shieldPct}%
          </div>
        </div>
      )}
      {bannerAlive && v.banner && (
        <div
          id="target-locked-banner"
          role="status"
          style={{
            ...PANEL,
            top: 64,
            left: '50%',
            transform: 'translateX(-50%)',
            color: '#ffd23f',
          }}
        >
          {v.banner.text}
        </div>
      )}
      {v.noTargetAt > 0 && now - v.noTargetAt < 1500 && (
        <div
          id="no-target-prompt"
          role="status"
          style={{
            ...PANEL,
            top: 96,
            left: '50%',
            transform: 'translateX(-50%)',
            color: '#ff5a5a',
          }}
        >
          NO TARGET
        </div>
      )}
      {threatAlive && v.threat && (
        <div
          id="threat-ping"
          role="status"
          data-testid="threat-ping"
          title={v.threat.attackerId}
          style={{
            position: 'fixed',
            left: '50%',
            top: '50%',
            zIndex: 94,
            pointerEvents: 'none',
            width: 0,
            height: 0,
            // The arc sits AHEAD of the ship marker and rotates by bearing.
            transform: `rotate(${(v.threat.bearing * 180) / Math.PI}deg)`,
            opacity: Math.max(0, (v.threat.expiresAt - now) / 3000),
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: -14,
              top: -190,
              width: 28,
              height: 16,
              background: '#ff2d2d',
              clipPath: 'polygon(50% 0, 100% 100%, 0 100%)',
            }}
          />
        </div>
      )}
    </>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 60,
        height: 6,
        background: 'rgba(255,255,255,0.15)',
        verticalAlign: 'middle',
        marginRight: 4,
      }}
    >
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
        }}
      />
    </span>
  );
}
