import React from 'react';

import { credits, creditsSubscribe } from '@client/state/credits';
import {
  creditFloats,
  creditFloatsSubscribe,
  removeCreditFloat,
  type CreditFloat,
} from '@client/state/credit-float';

/**
 * Credits HUD (TASK-40) — the two credit visuals: the persistent
 * `#credits-counter` (top-right, the HUD credit balance) and the transient
 * "+N cr" float layer (pops at the terminal after each sale). Both are thin
 * subscribers over the credits / credit-float stores — the data arrives on
 * session boot (/api/players/me) and on every 'sell' result frame.
 */

/** The persistent credit counter (top-right HUD). Hidden until a balance lands. */
export function CreditsCounter(): React.ReactElement | null {
  const [value, setValue] = React.useState(credits); // lazy init: current
  React.useEffect(() => creditsSubscribe(setValue), []);
  if (value === null) return null;
  return (
    <div
      id="credits-counter"
      style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        zIndex: 88,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.85rem',
        letterSpacing: '0.06em',
        color: '#f0c674',
        background: 'rgba(15, 20, 28, 0.8)',
        border: '1px solid #2c3a4d',
        borderRadius: '4px',
        padding: '0.3rem 0.6rem',
      }}
    >
      {value} cr
    </div>
  );
}

const FLOAT_LIFETIME_MS = 1100;

/** One floating credit text — rises + fades over its lifetime, then removes itself. */
function FloatItem({ float }: { float: CreditFloat }): React.ReactElement {
  React.useEffect(() => {
    const t = setTimeout(() => removeCreditFloat(float.id), FLOAT_LIFETIME_MS);
    return () => clearTimeout(t);
  }, [float.id]);
  return (
    <div
      key={float.id}
      className="drift-credit-float"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '18vh',
        transform: 'translateX(-50%)',
        zIndex: 89,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.95rem',
        fontWeight: 700,
        color: '#f0c674',
        textShadow: '0 1px 3px rgba(0,0,0,0.7)',
        pointerEvents: 'none',
        animation: `drift-rise ${FLOAT_LIFETIME_MS}ms ease-out forwards`,
      }}
    >
      {float.text}
    </div>
  );
}

/** The transient "+N cr" float layer (empty when nothing is floating). */
export function CreditFloatLayer(): React.ReactElement {
  const [floats, setFloats] = React.useState(creditFloats); // lazy init: current
  React.useEffect(() => creditFloatsSubscribe(setFloats), []);
  return (
    <>
      <style>{`@keyframes drift-rise { from { opacity: 1; translate: 0 0; } to { opacity: 0; translate: 0 -44px; } }`}</style>
      {floats.map((f) => (
        <FloatItem key={f.id} float={f} />
      ))}
    </>
  );
}
