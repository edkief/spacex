/**
 * Vitals bar (TASK-51) — the player's ship hull (amber) + shield (blue)
 * bars, top-left under the chat: two stacked bars, 200 px wide, numeric
 * values on hover, 10 Hz snapshot-driven. Flashes red for HIT_FLASH_MS
 * (300 ms) after a combat_event hit ON THE SELF SHIP (TASK-42 events —
 * main.tsx routes only self-targeted hits to flashHullHit).
 *
 * The flash is a 300 ms CSS class toggle driven by the hit store (a
 * re-render on the hit + one 300 ms timeout to clear — no rAF, no
 * interval; the bar itself re-renders at most at the 10 Hz snapshot
 * cadence via the self-ship view subscription).
 */
import React from 'react';
import {
  HIT_FLASH_MS,
  hitFlashActive,
  hullHitSubscribe,
  lastHullHitAtMs,
} from '@client/state/ship-hud';
import type { SelfShipView } from '@client/state/ship-hud';
import { vitalsRect } from './layout';
import { styleFromRect } from '@client/ui/combat-hud/layout';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const BAR_W = 192; // 200 px slot minus padding

export interface VitalsBarProps {
  viewport: { w: number; h: number };
  view: SelfShipView;
}

/** Hull/shield 0..1 → bar width px (200 px slot, spec). */
export function barWidthPx(fraction: number, width: number = BAR_W): number {
  return Math.round(Math.max(0, Math.min(1, fraction)) * width);
}

export function VitalsBar({ view }: VitalsBarProps): React.ReactElement {
  const [hitAt, setHitAt] = React.useState(() => lastHullHitAtMs());
  React.useEffect(() => hullHitSubscribe(setHitAt), []);
  const flashing = React.useMemo(() => hitFlashActive(), [hitAt]);
  // Clear the flash class exactly HIT_FLASH_MS after the hit (the timeout
  // exists only to force the one re-render past the window; re-arms on
  // every new hit).
  React.useEffect(() => {
    if (hitAt === 0 || hitAt + HIT_FLASH_MS <= Date.now()) return;
    const id = window.setTimeout(() => setHitAt(0), Math.max(0, hitAt + HIT_FLASH_MS - Date.now()));
    return () => window.clearTimeout(id);
  }, [hitAt]);

  const hullPct = Math.round(view.hull * 100);
  const shieldPct = Math.round(view.shields * 100);
  return (
    <div
      id="ship-hud-vitals"
      role="status"
      data-hit={flashing ? '1' : '0'}
      style={styleFromRect(vitalsRect(), {
        zIndex: 86,
        pointerEvents: 'none',
        boxSizing: 'border-box',
        padding: '6px 8px',
        background: flashing ? 'rgba(120, 16, 16, 0.85)' : 'rgba(17, 21, 31, 0.85)',
        border: `1px solid ${flashing ? '#f87171' : '#2a3346'}`,
        borderRadius: 6,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: '0.08em',
        color: '#d6deeb',
        transition: 'background 80ms linear, border-color 80ms linear',
      })}
    >
      {/* Numeric values ride beside the bars at all times (hover-proof). */}
      <Bar label="SHLD" pct={shieldPct} color="#38bdf8" />
      <Bar label="HULL" pct={hullPct} color="#f59e0b" />
    </div>
  );
}

function Bar({
  label,
  pct,
  color,
}: {
  label: string;
  pct: number;
  color: string;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
      <span style={{ width: 34, color: '#8b97ab' }}>{label}</span>
      <div
        style={{
          position: 'relative',
          width: BAR_W,
          height: 8,
          background: 'rgba(42, 51, 70, 0.8)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          data-hull={label === 'HULL' ? '1' : '0'}
          style={{
            width: barWidthPx(pct / 100),
            height: '100%',
            background: color,
          }}
        />
      </div>
      <span style={{ width: 28, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}
