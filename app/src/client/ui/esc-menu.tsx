import React from 'react';

import { menuSubscribe, topSurface } from '@client/state/menu';
import { useFocusTrap } from '@client/ui/focus-trap';
import { SETTING_KEYS } from '@shared/settings';
import { setSetting } from '@client/a11y/reduced-motion';
import { useReducedMotion } from '@client/a11y/use-reduced-motion';

/**
 * The ESC menu (TASK-53) — the centered modal shell: Resume / Systems
 * (opens the star chart, TASK-7) / Ships (opens the shared ship panel) /
 * Settings (TASK-55 stub) + a credits + callsign footer.
 *
 * The game keeps running while the menu is open — multiplayer: the world
 * never pauses (a player who opens the menu can still be shot; by design,
 * documented here on the surface itself). The menu is modal: main.tsx
 * gates every game input on `anySurfaceOpen()` (only ESC reaches the game
 * — the global menu-stack handler pops it).
 */

export interface EscMenuProps {
  callsign: string;
  /** The credit balance (the credits store; null until it is seeded). */
  credits: number | null;
  onResume: () => void;
  onSystems: () => void;
  onShips: () => void;
}

const ITEM_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'none',
  border: '1px solid transparent',
  borderRadius: '4px',
  color: '#d6deeb',
  fontFamily: 'inherit',
  fontSize: '0.8rem',
  letterSpacing: '0.12em',
  padding: '0.45rem 0.75rem',
  cursor: 'pointer',
};

export function EscMenu(props: EscMenuProps): React.ReactElement {
  const [showSettings, setShowSettings] = React.useState(false);
  const reducedMotion = useReducedMotion();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // The trap is live only while the menu is the TOP surface (a panel opened
  // from the menu takes the trap; the menu's is paused underneath).
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => menuSubscribe(() => bump()), []);
  const top = topSurface();
  useFocusTrap(rootRef, top?.kind === 'menu');

  return (
    <div
      id="esc-menu"
      role="dialog"
      aria-label="Menu"
      ref={rootRef}
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 111, // above the backdrop (110), below the shared panel (112)
        background: 'rgba(15, 20, 28, 0.95)',
        border: '1px solid #2c3a4d',
        borderRadius: '8px',
        padding: '1.25rem 1.5rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#9fb0c3',
        width: '280px',
        maxWidth: '92vw',
      }}
    >
      <div
        style={{
          color: '#e6edf3',
          fontWeight: 700,
          letterSpacing: '0.2em',
          marginBottom: '0.9rem',
          fontSize: '1rem',
        }}
      >
        DRIFT
      </div>
      <button id="esc-menu-resume" type="button" style={ITEM_STYLE} onClick={props.onResume}>
        RESUME
      </button>
      <button id="esc-menu-systems" type="button" style={ITEM_STYLE} onClick={props.onSystems}>
        SYSTEMS
      </button>
      <button id="esc-menu-ships" type="button" style={ITEM_STYLE} onClick={props.onShips}>
        SHIPS
      </button>
      <button
        id="esc-menu-settings"
        type="button"
        style={ITEM_STYLE}
        aria-pressed={showSettings}
        onClick={() => setShowSettings((v) => !v)}
      >
        SETTINGS
      </button>
      {showSettings && (
        <>
          {/* TASK-54: the reduced-motion toggle (immediate effect — the FX
              gate, the threat ping and the warp overlay subscribe). The
              shared key lives in @shared/settings (TASK-55 owns persistence
              + the rest of the settings surface). */}
          <button
            id="reduced-motion-toggle"
            type="button"
            role="switch"
            aria-checked={reducedMotion}
            onClick={() => setSetting(SETTING_KEYS.reducedMotion, !reducedMotion)}
            style={ITEM_STYLE}
          >
            REDUCED MOTION: {reducedMotion ? 'ON' : 'OFF'}
          </button>
          <p
            id="esc-menu-settings-stub"
            role="status"
            style={{ margin: '0.4rem 0 0', fontSize: '0.7rem', opacity: 0.65 }}
          >
            Quality presets and key remap land in TASK-55.
          </p>
        </>
      )}
      <div
        id="esc-menu-footer"
        style={{
          marginTop: '1rem',
          paddingTop: '0.6rem',
          borderTop: '1px solid #2c3a4d',
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.7rem',
        }}
      >
        <span id="esc-menu-credits" style={{ color: '#f0c674' }}>
          {props.credits !== null ? `${props.credits} cr` : '— cr'}
        </span>
        <span id="esc-menu-callsign">{props.callsign}</span>
      </div>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.65rem', opacity: 0.55 }}>
        The world keeps moving while the menu is open.
      </p>
    </div>
  );
}
