/**
 * Ship HUD (TASK-51) — the pilot's instrument panel: the bottom-left
 * flight-instrument block (speed readout + thrust vector bar, regime-aware
 * altitude, the SPACE/ATMOS/SURFACE regime tag from the server's
 * authoritative regime, the nav readout, and the green DOCKED tag with the
 * station name) plus the top-left vitals bar (hull + shield, hit flash).
 *
 * All values are snapshot-driven (10 Hz, server truth) — the ONLY per-frame
 * work is the nav arrow's rAF ref'd rotation (NavReadout). The HUD
 * unmounts (null, zero cost) while the player is on foot or before the
 * first self-ship snapshot. Layout slots live in ./layout (shared with the
 * disjointness test).
 */
import React from 'react';
import { cruiseState, cruiseStateSubscribe, type CruiseState } from '@client/state/cruise';
import { selfShipView, selfShipViewSubscribe, type SelfShipView } from '@client/state/ship-hud';
import { speedBlockRect } from './layout';
import { styleFromRect, type Viewport } from '@client/ui/combat-hud/layout';
import { formatAltitude, formatSpeed, regimeTag, thrustYawDeg } from './nav-math';
import { NavReadout, type NavSample } from './nav-readout';
import { VitalsBar } from './vitals-bar';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export interface ShipHudProps {
  viewport: Viewport;
  /** The live (predicted) self-ship pose for the nav arrow (render rate). */
  navSample: () => NavSample | null;
  /** The implicit dock target (nearest station) or null. */
  dockTarget: () => { name: string; pos: { x: number; y: number; z: number } } | null;
  /** The station name for the current pad (docked tag), or null. */
  stationName: (padId: string) => string | null;
}

export function ShipHud(props: ShipHudProps): React.ReactElement | null {
  const [view, setView] = React.useState<SelfShipView | null>(selfShipView);
  React.useEffect(() => selfShipViewSubscribe(setView), []);
  // TASK-85: the cruise tag (CRUISE / CRUISE BLOCKED) — render-rate input
  // through the emit-on-change store, so it only re-renders on changes.
  const [cruise, setCruise] = React.useState<CruiseState>(cruiseState);
  React.useEffect(() => cruiseStateSubscribe(setCruise), []);
  const [dockedName, setDockedName] = React.useState<string | null>(null);
  // The docked tag's station name only changes with the view (10 Hz).
  React.useEffect(() => {
    setDockedName(view?.padId ? props.stationName(view.padId) : null);
  }, [view, props]);

  if (!view) return null;
  return (
    <>
      <div
        id="ship-hud-block"
        style={styleFromRect(speedBlockRect(props.viewport), {
          zIndex: 86,
          pointerEvents: 'none',
          boxSizing: 'border-box',
          padding: '6px 10px',
          background: 'rgba(17, 21, 31, 0.85)',
          border: '1px solid #2a3346',
          borderRadius: 6,
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '0.06em',
          color: '#d6deeb',
        })}
      >
        <div id="ship-hud-speed" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 34, color: '#8b97ab' }}>SPD</span>
          <span>{formatSpeed(view.vel)}</span>
          <ThrustVectorBar vel={view.vel} rot={view.rot} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <span style={{ width: 34, color: '#8b97ab' }}>ALT</span>
          <span id="ship-hud-altitude">{formatAltitude(view.regime, view.pos)}</span>
          <span
            id="ship-hud-regime"
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              padding: '1px 6px',
              borderRadius: 3,
              border: '1px solid #2a3346',
              color: regimeColor(view.regime),
              background: 'rgba(11, 14, 20, 0.7)',
            }}
          >
            {regimeTag(view.regime)}
          </span>
          <CruiseTag state={cruise} />
        </div>
        <div style={{ marginTop: 4, minHeight: 14 }}>
          <NavReadout sample={props.navSample} dockTarget={props.dockTarget} />
        </div>
        {view.padId && (
          <div
            id="ship-hud-docked"
            role="status"
            style={{
              marginTop: 3,
              fontSize: 10,
              color: '#4ade80',
              letterSpacing: '0.1em',
            }}
          >
            DOCKED · {dockedName ?? 'STATION'}
          </div>
        )}
      </div>
      <VitalsBar viewport={props.viewport} view={view} />
    </>
  );
}

/** The small thrust-direction bar: rotated to the velocity's screen yaw. */
function ThrustVectorBar({
  vel,
  rot,
}: {
  vel: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
}): React.ReactElement {
  const yaw = thrustYawDeg(vel, rot);
  return (
    <span
      id="ship-hud-vector"
      aria-hidden
      style={{
        position: 'relative',
        width: 18,
        height: 18,
        border: '1px solid #2a3346',
        borderRadius: '50%',
        marginLeft: 6,
        flex: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 2,
          height: 7,
          background: '#67e8f9',
          transform: `translate(-50%, -50%) rotate(${yaw}deg) translateY(-5px)`,
        }}
      />
    </span>
  );
}

/**
 * TASK-85: the cruise tag next to the regime indicator. 'CRUISE' (bright
 * cyan, the space-regime colour) while boost is held AND allowed at the
 * predicted position; dimmed 'CRUISE BLOCKED' while Shift is held but the
 * clearance band is not clear — the player must see WHY nothing happens
 * near planets. Hidden entirely when Shift is not held. TASK-54: the tag
 * text carries the state (not just colour), and both colours clear
 * ≥ 4.5:1 on the tag background.
 */
function CruiseTag({ state }: { state: CruiseState }): React.ReactElement | null {
  if (!state.held) return null;
  const active = state.allowed;
  return (
    <span
      id="ship-hud-cruise"
      role="status"
      style={{
        fontSize: 9,
        padding: '1px 6px',
        borderRadius: 3,
        border: '1px solid #2a3346',
        letterSpacing: '0.1em',
        color: active ? '#67e8f9' : '#f59e0b',
        opacity: active ? 1 : 0.65,
        background: 'rgba(11, 14, 20, 0.7)',
      }}
    >
      {active ? 'CRUISE' : 'CRUISE BLOCKED'}
    </span>
  );
}

function regimeColor(regime: SelfShipView['regime']): string {
  switch (regime) {
    case 'space':
      return '#67e8f9';
    case 'atmosphere':
      return '#f59e0b';
    case 'surface':
      return '#4ade80';
  }
}
