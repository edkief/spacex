/**
 * TASK-50: the TARGET BOX — a bracket that tracks the locked target's
 * projected screen position (rAF, ref'd style — the only per-frame HUD
 * work) + the fixed-slot info card (right of center, 1/3 from the edge):
 * callsign (AI ships tagged 'AI'), live distance, hull + shield bars
 * (green → amber) and the weapon-locked indicator when the target has
 * locked the player. Hidden when the target is behind the camera or
 * beyond 1500 m.
 *
 * Data: state/targeting.ts (10 Hz snapshot cadence). The per-frame work
 * is timed into the frame monitor's 'hud' budget (TASK-57).
 */
import React from 'react';
import { targetingSubscribe, type TargetingView } from '@client/state/targeting';
import { frameMonitor } from '@client/perf/frameMonitor';
import { projectWorldToScreen, type CameraSample } from './projection';
import { HUD_BUDGET_MS, styleFromRect, targetBoxRect, type Viewport } from './layout';

/** Hide the box beyond this range (the lock release range). */
export const TARGET_BOX_RANGE_M = 1_500;

export interface TargetBoxProps {
  /** Layout slots are computed against this viewport. */
  viewport: Viewport;
  /** Live camera sample (null before the world exists). */
  camera: () => CameraSample | null;
}

export function TargetBox({ viewport, camera }: TargetBoxProps) {
  const [view, setView] = React.useState<TargetingView | null>(null);
  React.useEffect(() => targetingSubscribe(setView), []);
  const viewRef = React.useRef(view);
  viewRef.current = view;

  const bracketRef = React.useRef<HTMLDivElement | null>(null);
  const cameraRef = React.useRef(camera);
  cameraRef.current = camera;

  // The bracket tracks the projection every frame; the CARD visibility
  // flips only when the target actually leaves the camera frustum (a
  // state change — normally at most a few re-renders per second).
  const [behind, setBehind] = React.useState(false);
  const behindRef = React.useRef(false);

  React.useEffect(() => {
    frameMonitor.registerBudget('hud', HUD_BUDGET_MS);
    let raf = 0;
    const tick = () => {
      const t0 = performance.now();
      const el = bracketRef.current;
      const box = viewRef.current?.box;
      if (el && box && box.distance <= TARGET_BOX_RANGE_M) {
        const sample = cameraRef.current();
        const p = sample ? projectWorldToScreen(box.pos, sample) : null;
        if (p) {
          el.style.display = 'block';
          // The bracket (BRACKET_W × BRACKET_H) centers on the point.
          el.style.transform = `translate(${p.x - BRACKET_W / 2}px, ${p.y - BRACKET_H / 2}px)`;
        } else {
          el.style.display = 'none';
        }
        const next = !p;
        if (next !== behindRef.current) {
          behindRef.current = next;
          setBehind(next);
        }
      } else if (el) {
        el.style.display = 'none';
        if (behindRef.current) {
          behindRef.current = false;
          setBehind(false);
        }
      }
      frameMonitor.budgetCheck('hud', performance.now() - t0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const box = view?.box;
  if (!box || box.distance > TARGET_BOX_RANGE_M || behind) return null;

  return (
    <>
      {/* The bracket: 4 corner marks centered on the projected point. */}
      <div
        ref={bracketRef}
        id="target-bracket"
        data-testid="target-bracket"
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          display: 'none',
          zIndex: 96,
          pointerEvents: 'none',
        }}
      >
        <Corner side="tl" />
        <Corner side="tr" />
        <Corner side="bl" />
        <Corner side="br" />
      </div>
      <div
        id="target-box"
        role="status"
        data-testid="target-box"
        style={styleFromRect(targetBoxRect(viewport), {
          zIndex: 96,
          pointerEvents: 'none',
          boxSizing: 'border-box',
          overflow: 'hidden',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          color: '#cdd6e4',
          background: 'rgba(10, 14, 22, 0.62)',
          border: '1px solid rgba(120, 140, 170, 0.45)',
          padding: '6px 10px',
        })}
      >
        <div style={{ color: '#ff5a5a', letterSpacing: 1, fontSize: 10 }}>◤ TARGET ◢</div>
        <div style={{ margin: '2px 0 4px', color: '#ffffff', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {box.callsign}
          {box.isAi && (
            <span style={{ marginLeft: 6, color: '#e5484d', fontSize: 10 }} data-testid="target-ai-tag">
              AI
            </span>
          )}
        </div>
        <div style={{ marginBottom: 4 }}>{Math.round(box.distance)} m</div>
        <div style={{ marginBottom: 3 }}>
          HULL <Bar pct={box.hullPct} />
          {box.hullPct}%
        </div>
        <div>
          SHLD <Bar pct={box.shieldPct} />
          {box.shieldPct}%
        </div>
        {box.locksUs && (
          <div
            id="target-locks-us"
            data-testid="target-locks-us"
            style={{ color: '#ff2d2d', fontWeight: 'bold', marginTop: 2 }}
          >
            ⚠ LOCKED ON
          </div>
        )}
      </div>
    </>
  );
}

const BRACKET_W = 64;
const BRACKET_H = 44;
const CORNER = 12;

function Corner({ side }: { side: 'tl' | 'tr' | 'bl' | 'br' }) {
  const base: React.CSSProperties = {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderStyle: 'solid',
    borderColor: '#5ad17a',
    borderWidth: 0,
  };
  const halfW = BRACKET_W / 2;
  const halfH = BRACKET_H / 2;
  switch (side) {
    case 'tl':
      return <div style={{ ...base, left: -halfW, top: -halfH, borderWidth: '2px 0 0 2px' }} />;
    case 'tr':
      return <div style={{ ...base, left: halfW - CORNER, top: -halfH, borderWidth: '2px 2px 0 0' }} />;
    case 'bl':
      return <div style={{ ...base, left: -halfW, top: halfH - CORNER, borderWidth: '0 0 2px 2px' }} />;
    case 'br':
      return <div style={{ ...base, left: halfW - CORNER, top: halfH - CORNER, borderWidth: '0 2px 2px 0' }} />;
  }
}

/** Hull/shield bar: green above 50 %, amber below (spec: green/amber). */
function Bar({ pct }: { pct: number }) {
  const color = pct > 50 ? '#5ad17a' : '#ffd23f';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 56,
        height: 5,
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
