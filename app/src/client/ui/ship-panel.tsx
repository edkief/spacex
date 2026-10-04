import React from 'react';

import {
  INVENTORY_MAX_WEIGHT,
  listStacks,
  RESOURCE_WEIGHTS,
  type ResourceId,
} from '@shared/inventory';
import { CATALOG_IDS, RESOURCE_CATALOG } from '@shared/resources';
import { repairCost } from '@shared/physics/damage';
import {
  SHIP_CLASSES,
  LIVERY_SLOTS,
  type Livery,
  type LiverySlot,
  type ShipClass,
  type ShipClassId,
} from '@shared/ships';
import { canonicalJson } from '@shared/canonical';
import { weightBarColor } from '@client/ui/weight-bar';
import { useFocusTrap } from '@client/ui/focus-trap';
import {
  menuSubscribe,
  topSurface,
  type PanelContext,
  type PanelSurfaceId,
  type PanelTab,
} from '@client/state/menu';

/**
 * The shared ship/dock panel (TASK-53) — ONE component for every panel
 * context (the hard requirement that keeps the dock UI and the ship UI
 * from drifting apart):
 *
 * - context 'docked'  (docked ship, in cockpit or at the pad): OVERVIEW / CARGO / REPAIR
 * - context 'flight'  (in flight):                             OVERVIEW / CARGO
 * - context 'dock'    (on foot at the station terminal):       OVERVIEW / CARGO / SELL
 *
 * The tabs are the only context difference — the chrome, the Cargo tab
 * (the TASK-39 stack columns) and the Sell tab (the TASK-40 rows) are the
 * same implementation everywhere. Data is all in-memory (the 10 Hz self
 * entity, the cargo / dock stores, the credits store): opening costs a
 * plain render, the only network touch is the livery picker (debounced
 * 500 ms before it POSTs /api/ships/livery, TASK-21).
 *
 * Keyboard-first (the TASK-54 boundary): Tab cycles (focus-trapped), Enter
 * activates (native buttons), ArrowLeft/ArrowRight switch tabs, ESC backs
 * out (the global menu-stack handler in main.tsx).
 */

/** Livery save debounce (the AC: 5 rapid changes → 1 request). */
export const LIVERY_SAVE_DEBOUNCE_MS = 500;

/** The available tabs per context (the tab-set the shared component enforces). */
export function tabsForContext(context: PanelContext): readonly PanelTab[] {
  switch (context) {
    case 'docked':
      return ['overview', 'cargo', 'repair'];
    case 'flight':
      return ['overview', 'cargo'];
    case 'dock':
      return ['overview', 'cargo', 'sell'];
  }
}

const TAB_LABELS: Record<PanelTab, string> = {
  overview: 'OVERVIEW',
  cargo: 'CARGO',
  repair: 'REPAIR',
  sell: 'SELL',
};

/** The self-ship view the panel renders (10 Hz entity data, nulls at boot). */
export interface PanelShipView {
  classId: string | null;
  hull: number | null;
  shields: number | null;
  energy: number | null;
  livery: Livery | null;
}

/** The panel's hold view (the 'cargo'/'sell' frame wire shape). */
export interface PanelHoldView {
  stacks: Record<string, number>;
  weightUsed: number;
  capacity: number;
}

/** The panel's on-foot inventory view. */
export interface PanelInvView {
  stacks: Record<string, number>;
  weightUsed: number;
}

export interface ShipPanelProps {
  /** The root element id (the DOM contract: cargo-panel / dock-panel / ship-panel). */
  id: PanelSurfaceId;
  /** The header title (CARGO / STATION DOCK / SHIP). */
  title: string;
  context: PanelContext;
  /** The initially-active tab (must be available in the context). */
  activeTab: PanelTab;
  ship: PanelShipView;
  /** The player's ship is docked — the Repair action's gate (server: ship.state 'docked'). */
  docked: boolean;
  hold: PanelHoldView | null;
  inventory: PanelInvView | null;
  /** The credit balance (Sell tab line; null = hidden). */
  balance: number | null;
  onMove: (resourceId: ResourceId, amount: number, from: 'inv' | 'hold') => void;
  /** The Sell tab's only server contact (dock context). */
  onSell?: (resourceId: ResourceId, amount: number, source: 'hold' | 'inv') => void;
  /** The Repair action (dock-gated; the server is the authority). */
  onRepair?: () => void;
  /** The debounced livery save (the panel's only network-touching control). */
  onLivery?: (colors: Livery) => void;
  /** A transient repair error (rendered under the Repair tab). */
  repairMessage: string | null;
  onClose: () => void;
}

/** The class for a wire classId (null for unknown/missing ids — the panel never throws). */
export function shipClassFor(classId: string | null): ShipClass | null {
  if (classId === 'scout' || classId === 'freighter' || classId === 'interceptor') {
    return SHIP_CLASSES[classId as ShipClassId];
  }
  return null;
}

/** The panel's default paint: the wire livery, else the class default. */
export function initialLivery(ship: PanelShipView): Livery {
  const cls = shipClassFor(ship.classId);
  if (ship.livery) return ship.livery;
  if (cls) return cls.defaultLivery;
  return { hull: '#ffffff', accent: '#ffffff', trim: '#ffffff' };
}

/** One column (inventory or hold): weight line + a row per non-empty stack
 *  with its 'Move 1' / 'Move all' buttons (the TASK-39 component, embedded). */
function StackColumn(props: {
  title: string;
  stacks: Record<string, number>;
  weightUsed: number;
  cap: number;
  source: 'inv' | 'hold';
  movable: boolean;
  onMove: ShipPanelProps['onMove'];
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

/** One sellable resource row: name, base price, hold/inv amounts, Sell buttons (TASK-40). */
function SellRow(props: {
  resourceId: ResourceId;
  holdAmount: number;
  invAmount: number;
  onSell: (resourceId: ResourceId, amount: number, source: 'hold' | 'inv') => void;
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

/** One stat bar (hull / shields / energy): label + numeric + track. */
function StatBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}): React.ReactElement {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.3rem' }}>
      <span style={{ width: '5.5rem', opacity: 0.8 }}>{label}</span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        style={{ flex: '1 1 auto', height: '4px', background: '#1f2733', borderRadius: '2px' }}
      >
        <div style={{ width: `${fraction * 100}%`, height: '100%', background: color }} />
      </div>
      <span style={{ width: '4.5rem', textAlign: 'right' }}>
        {Math.round(value)} / {max}
      </span>
    </div>
  );
}

export function ShipPanel(props: ShipPanelProps): React.ReactElement {
  const available = tabsForContext(props.context);
  const [tab, setTab] = React.useState<PanelTab>(
    available.includes(props.activeTab) ? props.activeTab : available[0],
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // The trap is live only while THIS panel is the topmost surface (a panel
  // stacked over the menu must not let the menu's trap steal Tab).
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => menuSubscribe(() => bump()), []);
  const top = topSurface();
  useFocusTrap(rootRef, top?.kind === 'panel' && top.id === props.id);

  // Livery picker draft + the 500 ms save debounce (the AC's 5-changes-1-request).
  const [draft, setDraft] = React.useState<Livery>(() => initialLivery(props.ship));
  const saveTimer = React.useRef<number | null>(null);
  const liveryKey = props.ship.livery ? canonicalJson(props.ship.livery) : '';
  React.useEffect(() => {
    setDraft(initialLivery(props.ship));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveryKey]);
  React.useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );
  const onColorChange = (slot: LiverySlot, value: string): void => {
    const next: Livery = { ...draft, [slot]: value };
    setDraft(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      props.onLivery?.(next);
    }, LIVERY_SAVE_DEBOUNCE_MS);
  };

  const cls = shipClassFor(props.ship.classId);
  const repairCostNow =
    cls && props.ship.hull !== null && props.ship.shields !== null
      ? repairCost(cls.id, props.ship.hull, props.ship.shields)
      : null;

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = available.indexOf(tab);
    const next =
      e.key === 'ArrowRight'
        ? available[(idx + 1) % available.length]
        : available[(idx - 1 + available.length) % available.length];
    setTab(next);
    document.getElementById(`${props.id}-tab-${next}`)?.focus();
  };

  const hold = props.hold?.stacks ?? {};
  const inv = props.inventory?.stacks ?? {};
  const sellRows = CATALOG_IDS.filter((id) => (hold[id] ?? 0) + (inv[id] ?? 0) > 0);

  return (
    <div
      id={props.id}
      role="dialog"
      aria-label={props.title}
      ref={rootRef}
      onKeyDown={onKey}
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 112, // above the menu (111) and the backdrop (110)
        background: 'rgba(15, 20, 28, 0.95)',
        border: '1px solid #2c3a4d',
        borderRadius: '6px',
        padding: '1rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.75rem',
        color: '#9fb0c3',
        width: '480px',
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
          {props.title}
        </span>
        <button
          type="button"
          id={`${props.id}-close`}
          aria-label={`close ${props.title.toLowerCase()}`}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
        {available.map((t) => (
          <button
            key={t}
            type="button"
            id={`${props.id}-tab-${t}`}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            style={{
              opacity: tab === t ? 1 : 0.55,
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid #9fb0c3' : '2px solid transparent',
              color: 'inherit',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              padding: '0.15rem 0.25rem',
              cursor: 'pointer',
              letterSpacing: '0.08em',
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div>
          {cls ? (
            <>
              <div style={{ color: '#e6edf3', fontWeight: 700, marginBottom: '0.25rem' }}>
                {cls.name} <span style={{ opacity: 0.6 }}>({cls.id})</span>
              </div>
              <div style={{ opacity: 0.75, marginBottom: '0.5rem' }}>{cls.description}</div>
              <StatBar label="HULL" value={props.ship.hull ?? 0} max={cls.hull} color="#e6a23c" />
              <StatBar
                label="SHIELDS"
                value={props.ship.shields ?? 0}
                max={cls.shieldCapacity}
                color="#60a5fa"
              />
              <StatBar label="ENERGY" value={props.ship.energy ?? 0} max={100} color="#22d3ee" />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0.2rem 1rem',
                  marginTop: '0.5rem',
                  opacity: 0.85,
                }}
              >
                <span>max velocity: {cls.maxVelocity} u/s</span>
                <span>acceleration: {cls.acceleration} u/s²</span>
                <span>turn rate: {cls.turnRate} rad/s</span>
                <span>mass: {cls.mass} u</span>
                <span>cargo: {cls.cargoSlots} slots ({cls.maxWeight} u)</span>
                <span>
                  weapons: laser ×{cls.weaponMounts.laser}
                  {cls.weaponMounts.missiles > 0 ? ` · missile ×${cls.weaponMounts.missiles}` : ''}
                </span>
              </div>
              <div id={`${props.id}-livery`} style={{ marginTop: '0.6rem' }}>
                <span style={{ opacity: 0.8, letterSpacing: '0.08em' }}>LIVERY</span>
                {LIVERY_SLOTS.map((slot) => (
                  <label
                    key={slot}
                    style={{ marginLeft: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                  >
                    {slot}
                    <input
                      id={`${props.id}-livery-${slot}`}
                      type="color"
                      value={draft[slot]}
                      aria-label={`livery ${slot}`}
                      onChange={(e) => onColorChange(slot, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div style={{ opacity: 0.6 }}>No ship data.</div>
          )}
        </div>
      )}

      {tab === 'cargo' && (
        <div>
          {props.hold ? (
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
              {props.inventory && (
                <StackColumn
                  title="INVENTORY"
                  stacks={props.inventory.stacks}
                  weightUsed={props.inventory.weightUsed}
                  cap={INVENTORY_MAX_WEIGHT}
                  source="inv"
                  movable
                  onMove={props.onMove}
                />
              )}
              <StackColumn
                title="CARGO HOLD"
                stacks={props.hold.stacks}
                weightUsed={props.hold.weightUsed}
                cap={props.hold.capacity}
                source="hold"
                movable={props.inventory !== null}
                onMove={props.onMove}
              />
            </div>
          ) : (
            <div id={`${props.id}-cargo-empty`} style={{ opacity: 0.6 }}>
              No cargo data — open the cargo at your ship.
            </div>
          )}
          {props.hold && !props.inventory && (
            <div style={{ marginTop: '0.75rem', opacity: 0.7 }}>
              Transfers need you on foot at your docked ship.
            </div>
          )}
        </div>
      )}

      {tab === 'repair' && (
        <div>
          {cls && props.ship.hull !== null && props.ship.shields !== null ? (
            <>
              <div style={{ marginBottom: '0.4rem' }}>
                hull {props.ship.hull}/{cls.hull} · shields {props.ship.shields}/
                {cls.shieldCapacity}
              </div>
              <div id={`${props.id}-repair-cost`} style={{ color: '#f0c674', marginBottom: '0.5rem' }}>
                repair cost: {repairCostNow} cr
              </div>
              <button
                id={`${props.id}-repair`}
                type="button"
                disabled={!props.docked}
                style={{
                  opacity: props.docked ? 1 : 0.4,
                  background: '#134e4a',
                  border: '1px solid #16a34a',
                  borderRadius: 6,
                  color: '#d6deeb',
                  padding: '0.4rem 0.9rem',
                  cursor: props.docked ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  letterSpacing: '0.08em',
                }}
                onClick={props.onRepair}
              >
                REPAIR
              </button>
              {!props.docked && (
                <div id={`${props.id}-repair-reason`} style={{ marginTop: '0.4rem', opacity: 0.7 }}>
                  Repair requires a docked ship.
                </div>
              )}
            </>
          ) : (
            <div style={{ opacity: 0.6 }}>No ship data.</div>
          )}
          {props.repairMessage && (
            <div role="alert" style={{ marginTop: '0.5rem', color: '#f87171' }}>
              {props.repairMessage}
            </div>
          )}
        </div>
      )}

      {tab === 'sell' && (
        <div>
          {props.balance !== null && (
            <div id={`${props.id}-balance`} style={{ marginBottom: '0.5rem', color: '#f0c674' }}>
              credits: {props.balance}
            </div>
          )}
          {sellRows.length === 0 && (
            <div style={{ opacity: 0.6 }}>Nothing to sell — your hold and inventory are empty.</div>
          )}
          {sellRows.map((id) => (
            <SellRow
              key={id}
              resourceId={id}
              holdAmount={hold[id] ?? 0}
              invAmount={inv[id] ?? 0}
              onSell={(rid, amount, source) => props.onSell?.(rid, amount, source)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
