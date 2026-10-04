import React from 'react';

import {
  miningGain,
  miningSubscribe,
  miningView,
  type MiningGain,
  type MiningView,
} from '@client/state/mining';

/**
 * Interaction line (TASK-52) — the single bottom-center prompt line for ALL
 * on-foot actions (TASK-33's registry: '[E] Take iron x3' / '[E] Enter ship'
 * / '[E] Dock terminal' / 'Hold [E] to mine …'). ONE prompt at a time (the
 * raycast is nearest-wins — see input/interaction.ts), hidden when nothing
 * is in range.
 *
 * While a mining channel runs (TASK-38), the radial progress ring is drawn
 * AROUND this line (the units counter inside it) — the only per-frame HUD
 * work: an rAF loop writes the conic-gradient angle of a ref'd div from the
 * server's 10 Hz `miningProgress` (no React re-render, no client timer —
 * the server's clock stays the only truth). The '+1 <resource>' float and
 * the 'Backpack full' / 'Depleted' states ride the same line.
 *
 * Keeps the TASK-33 `#interact-prompt` and TASK-38 `#mining-hud` ids (the
 * e2e specs assert both).
 */

/** The ring's conic-gradient for one progress value (0 → empty, 1 → full). */
export function miningRingGradient(progress: number): string {
  const deg = Math.min(1, Math.max(0, progress)) * 360;
  return `conic-gradient(#7dd3fc ${deg}deg, rgba(42, 51, 70, 0.55) ${deg}deg)`;
}

/**
 * The status line the HUD owes the player: 'Backpack full' while the
 * channel is PAUSED at the weight cap, 'Depleted' when the deposit ran out
 * mid-channel (the server's ended echo), nothing while mining runs.
 */
export function miningHudStatus(view: MiningView): string | null {
  if (view.kind === 'active') return view.frame.status === 'full' ? 'Backpack full' : null;
  if (view.kind === 'ended' && view.frame.reason === 'depleted') return 'Depleted';
  return null;
}

/** The 'Depleted' prompt lingers this long after the final echo (cosmetic). */
const DEPLETED_LINGER_MS = 2_500;
/** One '+1 <resource>' float's lifetime (its CSS fade runs the same span). */
const GAIN_LINGER_MS = 1_000;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const FLOAT_CSS = `@keyframes mining-float {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-16px); }
}`;

/** The channel view + latest gain float (re-render on the server's echoes). */
function useMining(): { view: MiningView; gain: MiningGain | null } {
  const [state, setState] = React.useState(() => ({
    view: miningView(),
    gain: miningGain(),
  }));
  React.useEffect(
    () =>
      miningSubscribe(() => {
        const view = miningView();
        const gain = miningGain();
        setState((s) => (s.view === view && s.gain === gain ? s : { view, gain }));
      }),
    [],
  );
  return state;
}

/**
 * The mining radial ring (around the prompt line). While a channel is
 * active, an rAF loop writes the conic-gradient angle of the ref'd div from
 * the latest server echo — a plain style write, no React re-render (the AC
 * perf rule: the ONLY per-frame on-foot HUD work). Idle → null.
 */
function MiningRadial({ view }: { view: MiningView }): React.ReactElement | null {
  const ringRef = React.useRef<HTMLDivElement | null>(null);
  const discRef = React.useRef<HTMLDivElement | null>(null);
  // The latest server progress (10 Hz) — the rAF loop's only input.
  const progressRef = React.useRef(0);
  const active = view.kind === 'active';
  const progress = active ? view.frame.progress : 0;
  progressRef.current = active ? progress : 0;
  React.useEffect(() => {
    if (view.kind !== 'active') return undefined;
    let raf = 0;
    let lastDeg = -1;
    const step = () => {
      // A conic-gradient angle write from the server's miningProgress —
      // skip the write when the 10 Hz echo hasn't moved (cheap no-op).
      const deg = Math.min(1, Math.max(0, progressRef.current)) * 360;
      if (deg !== lastDeg && ringRef.current) {
        ringRef.current.style.background = `conic-gradient(#7dd3fc ${deg}deg, rgba(42, 51, 70, 0.55) ${deg}deg)`;
        lastDeg = deg;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [view.kind]);
  if (view.kind !== 'active') return null;
  return (
    <div
      id="mining-hud"
      role="presentation"
      style={{ position: 'relative', width: 30, height: 30 }}
    >
      <div ref={ringRef} style={{ width: 30, height: 30, borderRadius: '50%' }} />
      {/* The inner disc masks the donut; the ore counter sits in it. */}
      <div
        ref={discRef}
        style={{
          position: 'absolute',
          inset: 3,
          borderRadius: '50%',
          background: '#11151f',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#d6deeb',
          fontFamily: MONO,
          fontSize: '0.68rem',
        }}
      >
        {view.frame.units}
      </div>
    </div>
  );
}

export function InteractionLine({ text }: { text: string | null }): React.ReactElement | null {
  const { view, gain } = useMining();
  // The 'Depleted' prompt lingers briefly (client timer — pure cosmetics;
  // the truth is the server's ended frame, this is only how long to SHOW it).
  const [linger, setLinger] = React.useState(false);
  React.useEffect(() => {
    const show = view.kind === 'ended' && view.frame.reason === 'depleted';
    if (show) {
      setLinger(true);
      const t = setTimeout(() => setLinger(false), DEPLETED_LINGER_MS);
      return () => clearTimeout(t);
    }
    setLinger(false);
    return undefined;
  }, [view]);
  // The gain float unmounts after its 1 s fade (no permanent DOM node).
  const [floatKey, setFloatKey] = React.useState(0);
  React.useEffect(() => {
    if (!gain) return;
    setFloatKey(gain.key);
    const t = setTimeout(() => setFloatKey(0), GAIN_LINGER_MS);
    return () => clearTimeout(t);
  }, [gain]);

  const label =
    view.kind === 'active' && view.frame.status === 'full'
      ? 'Backpack full'
      : linger
        ? 'Depleted'
        : null;
  const miningActive = view.kind === 'active';
  if (!text && !miningActive && !linger && floatKey === 0) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: '4.5rem', // the on-foot prompt line
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'none',
        zIndex: 86,
      }}
    >
      {floatKey > 0 && gain && (
        <div
          key={floatKey}
          style={{
            animation: 'mining-float 1s ease-out forwards',
            color: '#7dd3fc',
            fontFamily: MONO,
            fontSize: '0.72rem',
            letterSpacing: '0.08em',
            whiteSpace: 'nowrap',
          }}
        >
          +1 {gain.resource}
        </div>
      )}
      {label && (
        <div
          style={{
            padding: '0.2rem 0.7rem',
            border: '1px solid #2a3346',
            borderRadius: 6,
            background: 'rgba(17, 21, 31, 0.85)',
            color: label === 'Backpack full' ? '#f59e0b' : '#d6deeb',
            fontFamily: MONO,
            fontSize: '0.72rem',
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      )}
      {/* The prompt line: the radial (mining) is drawn AROUND it. */}
      {(text || miningActive) && (
        <div
          id="interact-prompt"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0.3rem 0.9rem',
            border: '1px solid #2a3346',
            borderRadius: 6,
            background: 'rgba(17, 21, 31, 0.85)',
            color: '#d6deeb',
            fontFamily: MONO,
            fontSize: '0.75rem',
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
          }}
        >
          <MiningRadial view={view} />
          {text && <span>{text}</span>}
        </div>
      )}
      {floatKey > 0 && <style>{FLOAT_CSS}</style>}
    </div>
  );
}
