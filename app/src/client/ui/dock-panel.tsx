import React from 'react';

import { CATALOG_IDS, RESOURCE_CATALOG } from '@shared/resources';
import type { ResourceId } from '@shared/inventory';
import {
  dockPanel,
  dockPanelSubscribe,
  closeDockPanel,
  type DockPanelState,
} from '@client/state/dock';

/**
 * Dock panel (TASK-40) — the station market UI opened by the server's
 * 'ui-open' {ui:'dock'} frame (the terminal interaction). Three tabs:
 * SELL (live, this task) and SHIPS / REPAIR (stubs — they land in TASK-53).
 *
 * The Sell tab lists every resource the player can sell (hold + on-foot
 * inventory combined, per the catalog order) with the catalog base price and
 * a 'Sell' action per SOURCE (the hold — docked ship — and the on-foot
 * inventory — within 10 m of the terminal). The panel never talks to the
 * server itself: it only calls onSell (main.tsx sends the 'sell' frame —
 * the one-dispatch-site pattern of the cargo panel). The 'sell' result frame
 * re-renders it (the source stack decreases, the balance line updates).
 */

export interface DockPanelProps {
  /** Send a 'sell' frame (the panel's only server contact). */
  onSell: (resourceId: ResourceId, amount: number, source: 'hold' | 'inv') => void;
}

type DockTab = 'sell' | 'ships' | 'repair';

function useDockPanel(): DockPanelState {
  const [state, setState] = React.useState(dockPanel); // lazy init: current
  React.useEffect(() => dockPanelSubscribe(setState), []);
  return state;
}

/** One sellable resource row: name, base price, hold/inv amounts, Sell buttons. */
function SellRow(props: {
  resourceId: ResourceId;
  holdAmount: number;
  invAmount: number;
  onSell: DockPanelProps['onSell'];
}): React.ReactElement {
  const price = RESOURCE_CATALOG[props.resourceId].basePrice;
  const { resourceId, holdAmount, invAmount, onSell } = props;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        marginTop: '0.4rem',
        padding: '0.35rem 0.5rem',
        background: 'rgba(15, 20, 28, 0.6)',
        borderRadius: '4px',
      }}
    >
      <span style={{ flex: '1 1 auto' }}>
        {resourceId} <span style={{ opacity: 0.65 }}>· {price} cr/u</span>
      </span>
      <span style={{ opacity: 0.75, fontSize: '0.7rem' }}>
        hold {holdAmount} · inv {invAmount}
      </span>
      {holdAmount > 0 && (
        <>
          <button
            type="button"
            aria-label={`sell 1 ${resourceId} hold`}
            onClick={() => onSell(resourceId, 1, 'hold')}
          >
            hold 1
          </button>
          <button
            type="button"
            aria-label={`sell all ${resourceId} hold`}
            onClick={() => onSell(resourceId, holdAmount, 'hold')}
          >
            hold all
          </button>
        </>
      )}
      {invAmount > 0 && (
        <>
          <button
            type="button"
            aria-label={`sell 1 ${resourceId} inv`}
            onClick={() => onSell(resourceId, 1, 'inv')}
          >
            inv 1
          </button>
          <button
            type="button"
            aria-label={`sell all ${resourceId} inv`}
            onClick={() => onSell(resourceId, invAmount, 'inv')}
          >
            inv all
          </button>
        </>
      )}
    </div>
  );
}

export function DockPanel({ onSell }: DockPanelProps): React.ReactElement | null {
  const state = useDockPanel();
  const [tab, setTab] = React.useState<DockTab>('sell');

  // Esc closes (typing in an input — chat — never does).
  React.useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      closeDockPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open]);

  if (!state.open) return null;

  const hold = state.hold?.stacks ?? {};
  const inv = state.inventory?.stacks ?? {};
  const rows = CATALOG_IDS.filter((id) => (hold[id] ?? 0) + (inv[id] ?? 0) > 0);

  const tabButton = (id: DockTab, label: string): React.ReactElement => (
    <button
      type="button"
      id={`dock-tab-${id}`}
      aria-pressed={tab === id}
      style={{
        opacity: tab === id ? 1 : 0.55,
        borderBottom: tab === id ? '2px solid #9fb0c3' : '2px solid transparent',
      }}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <div
      id="dock-panel"
      role="dialog"
      aria-label="dock"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 95, // same layer as the cargo panel
        background: 'rgba(15, 20, 28, 0.95)',
        border: '1px solid #2c3a4d',
        borderRadius: '6px',
        padding: '1rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.75rem',
        color: '#9fb0c3',
        width: '420px',
        maxWidth: '92vw',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.5rem',
        }}
      >
        <span style={{ color: '#e6edf3', fontWeight: 700, letterSpacing: '0.1em' }}>
          STATION DOCK
        </span>
        <button
          type="button"
          id="dock-panel-close"
          aria-label="close dock"
          onClick={closeDockPanel}
        >
          ×
        </button>
      </div>

      {state.balance !== null && (
        <div id="dock-balance" style={{ marginBottom: '0.5rem', color: '#f0c674' }}>
          credits: {state.balance}
        </div>
      )}

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
        {tabButton('sell', 'SELL')}
        {tabButton('ships', 'SHIPS')}
        {tabButton('repair', 'REPAIR')}
      </div>

      {tab === 'sell' && (
        <div>
          {rows.length === 0 && (
            <div style={{ opacity: 0.6 }}>Nothing to sell — your hold and inventory are empty.</div>
          )}
          {rows.map((id) => (
            <SellRow
              key={id}
              resourceId={id}
              holdAmount={hold[id] ?? 0}
              invAmount={inv[id] ?? 0}
              onSell={onSell}
            />
          ))}
        </div>
      )}
      {tab === 'ships' && <div style={{ opacity: 0.6 }}>Ship purchases land in TASK-53.</div>}
      {tab === 'repair' && <div style={{ opacity: 0.6 }}>Repairs land in TASK-53.</div>}
    </div>
  );
}
