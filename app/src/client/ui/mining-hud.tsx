import React from 'react';

import {
  miningGain,
  miningSubscribe,
  miningView,
  type MiningGain,
  type MiningView,
} from '@client/state/mining';

/**
 * Mining channel HUD (TASK-38) — the radial progress ring (CSS
 * conic-gradient) driven by the SERVER's 10 Hz echo (the client never runs
 * its own channel timer — the server's clock is the only truth), the
 * '+1 <resource>' float (1 s fade, one per awarded unit — the ore counter)
 * and the 'Backpack full' (weight cap) / 'Depleted' (the deposit ran out
 * mid-channel) prompt states. Sits above the bottom-center interact prompt;
 * null (zero cost) when idle.
 */

/** The 'Depleted' prompt lingers this long after the final echo (cosmetic). */
const DEPLETED_LINGER_MS = 2_500;
/** One '+1 <resource>' float's lifetime (its CSS fade runs the same span). */
const GAIN_LINGER_MS = 1_000;

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

export function MiningHud(): React.ReactElement | null {
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

  const active = view.kind === 'active' ? view.frame : null;
  const label = active && active.status === 'full' ? 'Backpack full' : linger ? 'Depleted' : null;
  if (!active && !linger && floatKey === 0) return null;
  return (
    <div
      id="mining-hud"
      role="status"
      style={{
        position: 'fixed',
        bottom: '6.4rem', // just above the interact prompt (4.5rem)
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'none',
        zIndex: 87, // above the prompt (86); below the star chart (90)
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
      {active && (
        <div style={{ position: 'relative', width: 30, height: 30 }}>
          {/* The radial progress (server echo, 0 → 100% over the 1.5 s unit). */}
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: miningRingGradient(active.progress),
            }}
          />
          {/* The inner disc masks the donut; the ore counter sits in it. */}
          <div
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
            {active.units}
          </div>
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
      {floatKey > 0 && <style>{FLOAT_CSS}</style>}
    </div>
  );
}
