import type { GameView } from '../game.ts';

/** Formats a speed in m/s as m/s or km/s. */
export function formatSpeed(speed: number): string {
  return speed >= 10_000 ? `${(speed / 1000).toFixed(1)} km/s` : `${speed.toFixed(0)} m/s`;
}

const STATUS_TEXT: Readonly<Record<GameView['status'], string>> = {
  connecting: 'Connecting…',
  handshaking: 'Connecting…',
  online: 'Online',
  closed: 'Disconnected',
  error: 'Connection problem',
};

/** Minimal flight HUD: who and where you are, link state, speed, regime and docking state. */
export function Hud({ view }: { view: GameView }) {
  const mooring = view.docked ? 'DOCKED — press U to undock' : view.landed ? 'LANDED' : undefined;
  return (
    <div className="hud" data-testid="hud">
      <div className="hud-top">
        <span data-testid="hud-callsign">{view.callsign}</span>
        <span>{view.systemName}</span>
        <span data-testid="hud-status" data-status={view.status}>
          {STATUS_TEXT[view.status]}
        </span>
        <span>{view.players} in system</span>
      </div>
      <div className="hud-bottom">
        <span data-testid="hud-speed">{formatSpeed(view.speed)}</span>
        <span data-testid="hud-regime">{(view.regime ?? '—').toUpperCase()}</span>
        {mooring ? <span data-testid="hud-mooring">{mooring}</span> : null}
        <span className="hint">
          W/S thrust · A/D yaw · ↑/↓ pitch · Q/E roll · Space/C up/down · X brake · G dock
        </span>
      </div>
    </div>
  );
}
