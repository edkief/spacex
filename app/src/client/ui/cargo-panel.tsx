import React from 'react';

import { INVENTORY_MAX_WEIGHT, listStacks, RESOURCE_WEIGHTS, type ResourceId } from '@shared/inventory';
import {
  cargoPanel,
  cargoPanelSubscribe,
  closeCargoPanel,
  type CargoPanelState,
} from '@client/state/cargo';
import { weightBarColor } from '@client/ui/weight-bar';

/**
 * Cargo panel (TASK-39) — the DOM 'cargo' UI: two columns (INVENTORY |
 * CARGO HOLD), each with its weight bar + the stacks' 'Move' buttons
 * (move 1 / move all per resource). The hold is ALWAYS the destination of
 * 'Move' in the inventory column (from 'inv' — loading the hold); the hold
 * column's buttons unload back into the inventory (from 'hold') and exist
 * ONLY while on foot at the ship — in flight the frame omits the inventory
 * and the panel is the hold only (transfers require being on foot).
 *
 * Driven by state/cargo (the server's per-connection 'cargo' frame — the
 * panel re-renders from it after every 'cargo_transfer'). The panel never
 * talks to the server itself: it only calls onMove (main.tsx sends the
 * 'cargo_transfer' frame — the registry/lint pattern: one dispatch site).
 * Esc or the close button closes it.
 */

export interface CargoPanelProps {
  /** Send a 'cargo_transfer' frame (the panel's only server contact). */
  onMove: (resourceId: ResourceId, amount: number, from: 'inv' | 'hold') => void;
}

/** The panel's React view (subscribed — re-renders only on real changes). */
function useCargoPanel(): CargoPanelState {
  const [state, setState] = React.useState(cargoPanel); // lazy init: current
  React.useEffect(() => cargoPanelSubscribe(setState), []);
  return state;
}

/** One column's weight line: '12 / 40 u' + the colored bar (shared colors). */
function WeightLine({ used, cap, label }: { used: number; cap: number; label: string }) {
  const fraction = cap > 0 ? Math.min(1, used / cap) : 0;
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span aria-label={`weight ${used} of ${cap}`}>
          {used} / {cap} u
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={cap}
        style={{
          height: '4px',
          background: '#1f2733',
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${fraction * 100}%`,
            height: '100%',
            background: weightBarColor(used, cap),
          }}
        />
      </div>
    </div>
  );
}

/**
 * One column (inventory or hold): weight line + a row per non-empty stack
 * with its 'Move 1' / 'Move all' buttons. `source` selects the frame's
 * `from` ('inv' = load into the hold, 'hold' = unload into the inventory);
 * `movable` false renders the rows read-only (the in-flight hold view).
 */
function StackColumn(props: {
  title: string;
  stacks: Record<string, number>;
  weightUsed: number;
  cap: number;
  source: 'inv' | 'hold';
  movable: boolean;
  onMove: CargoPanelProps['onMove'];
}): React.ReactElement {
  const rows = listStacks(props.stacks);
  return (
    <div style={{ minWidth: '220px', flex: '1 1 220px' }}>
      <div style={{ color: '#e6edf3', fontWeight: 700, marginBottom: '0.25rem' }}>{props.title}</div>
      <WeightLine used={props.weightUsed} cap={props.cap} label="weight" />
      {rows.length === 0 && <div style={{ opacity: 0.6 }}>empty</div>}
      {rows.map((row) => {
        const weight = row.amount * RESOURCE_WEIGHTS[row.resourceId];
        return (
          <div
            key={row.resourceId}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}
          >
            <span style={{ flex: '1 1 auto' }}>
              {row.resourceId} x{row.amount} <span style={{ opacity: 0.6 }}>({weight}u)</span>
            </span>
            {props.movable && (
              <>
                <button
                  type="button"
                  aria-label={`move 1 ${row.resourceId}`}
                  onClick={() => props.onMove(row.resourceId, 1, props.source)}
                >
                  1
                </button>
                <button
                  type="button"
                  aria-label={`move all ${row.resourceId}`}
                  onClick={() => props.onMove(row.resourceId, row.amount, props.source)}
                >
                  All
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CargoPanel({ onMove }: CargoPanelProps): React.ReactElement | null {
  const state = useCargoPanel();
  // Esc closes (typing in an input — chat — never does).
  React.useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      closeCargoPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open]);

  if (!state.open || !state.hold) return null;
  const inFlight = state.inventory === null; // hold-only view (no transfers)
  return (
    <div
      id="cargo-panel"
      role="dialog"
      aria-label="cargo"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 95, // above the star chart (90); below nothing in v1
        background: 'rgba(15, 20, 28, 0.95)',
        border: '1px solid #2c3a4d',
        borderRadius: '6px',
        padding: '1rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.75rem',
        color: '#9fb0c3',
        maxWidth: '560px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <span style={{ color: '#e6edf3', fontWeight: 700, letterSpacing: '0.1em' }}>CARGO</span>
        <button
          type="button"
          id="cargo-panel-close"
          aria-label="close cargo"
          onClick={closeCargoPanel}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
        {state.inventory && (
          <StackColumn
            title="INVENTORY"
            stacks={state.inventory.stacks}
            weightUsed={state.inventory.weightUsed}
            cap={INVENTORY_MAX_WEIGHT}
            source="inv"
            movable
            onMove={onMove}
          />
        )}
        <StackColumn
          title="CARGO HOLD"
          stacks={state.hold.stacks}
          weightUsed={state.hold.weightUsed}
          cap={state.hold.capacity}
          source="hold"
          movable={!inFlight}
          onMove={onMove}
        />
      </div>
      {inFlight && (
        <div style={{ marginTop: '0.75rem', opacity: 0.7 }}>
          Transfers need you on foot at your docked ship.
        </div>
      )}
    </div>
  );
}
