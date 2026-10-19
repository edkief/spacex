/**
 * Dock panel — TASK-40 dock sell UI.
 *
 * Modal that mounts when the server emits a `ui_open` frame for a
 * dock terminal (the on-foot player pressed `E` on a
 * `dock-terminal` interactable). Renders a Sell tab that lists
 * every deposit resource with its base price + the player's
 * combined sellable amount (hold + on-foot inventory) so they
 * can choose how much to cash out.
 *
 * ## Wire contract
 *
 *   - **Open**: server emits `ui_open { ui: "dock" }`. The host
 *     shell (App.tsx) toggles `open: true`.
 *   - **Sell**: client sends `sell { resourceType, quantity,
 *     source?: 'inv' | 'hold' }` per click. The server validates
 *     "at a station" against the bound entity (ship / character),
 *     debits the source, and emits `sell_ok` with the new
 *     balance.
 *   - **Credits counter**: the host shell subscribes to
 *     `DriftClient.onSellOk(...)` and re-renders the credits
 *     counter on every ack.
 *
 * ## Floating "+N cr" feedback
 *
 * Each successful `sell_ok` triggers a 1-second floating text
 * element at the terminal that fades out (`drift-mining-float`
 * keyframe). The component queues them so rapid sells stack as
 * separate floats.
 *
 * ## Layout
 *
 *   - Tabs: "Sell" (active), "Ships" / "Repair" (stubs for
 *     TASK-53 to flesh out).
 *   - Sell tab body: resource table with per-row price column +
 *     sellable column + per-row "Sell 1 / Sell all" buttons.
 *   - Right rail: live credits counter + recent transaction log.
 *
 * The panel hides when `open === false`. The host shell mounts
 * it once per session and toggles `open` from a single source
 * (the `ui_open` listener).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";

import type { CargoHold, CargoResourceType } from "@shared/world/cargo.js";
import { CARGO_RESOURCE_TYPES, CARGO_WEIGHT_PER_UNIT } from "@shared/world/cargo.js";
import { RESOURCE_CATALOG, type ResourceId } from "@shared/resources.js";
import type { Inventory } from "@shared/world/inventory.js";

import type { DriftClient } from "../net/wsClient.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-row colour cue mirroring the CargoPanel so the eye can spot the
 * resource type at a glance. */
const RESOURCE_COLOURS: Readonly<Record<CargoResourceType, string>> = {
  iron: "#9aa6b2",
  copper: "#d18a4f",
  "rare-earths": "#b48cf8",
  crystal: "#7adfff",
};

/** Floating "+N cr" lifetime in ms. */
const FLOAT_LIFETIME_MS = 1000;

/** Maximum floating texts on screen at once (older ones get culled). */
const MAX_FLOATS = 5;

/** Tab ids (TASK-40 ships/repair are stubs for TASK-53). */
type TabId = "sell" | "ships" | "repair";

interface TabDescriptor {
  readonly id: TabId;
  readonly label: string;
  readonly stub: boolean;
}

const TABS: readonly TabDescriptor[] = [
  { id: "sell", label: "Sell", stub: false },
  { id: "ships", label: "Ships", stub: true },
  { id: "repair", label: "Repair", stub: true },
];

// ---------------------------------------------------------------------------
// Hook — onSellOk subscription + floating texts
// ---------------------------------------------------------------------------

export interface DockPanelProps {
  client: DriftClient | null;
  inventory: Inventory | null;
  cargo: CargoHold | null;
  /** Latest known credit balance; rendered in the right rail. */
  balance: number;
  open: boolean;
  onClose: () => void;
}

interface FloatDescriptor {
  id: number;
  text: string;
  bornAtMs: number;
}

/**
 * The dock sell panel. Hosts the Sell tab + the Ships/Repair stubs
 * (TASK-53). The component is intentionally self-contained — it
 * subscribes to `sell_ok` frames internally so the host shell
 * doesn't need to wire listeners.
 */
export function DockPanel({
  client,
  inventory,
  cargo,
  balance,
  open,
  onClose,
}: DockPanelProps): React.JSX.Element | null {
  const [tab, setTab] = useState<TabId>("sell");
  const [floats, setFloats] = useState<readonly FloatDescriptor[]>([]);
  const [transactionLog, setTransactionLog] = useState<
    readonly { id: number; text: string; ts: number }[]
  >([]);

  // Subscribe to sell_ok frames. Each ack produces one floating
  // text + one log entry.
  useEffect(() => {
    if (!client) return;
    const unsub = client.onSellOk((payload) => {
      const id = Date.now() + Math.random();
      const text = `+${payload.earned} cr`;
      setFloats((prev) => {
        const next = [...prev, { id, text, bornAtMs: Date.now() }];
        // Cull older entries so the DOM stays bounded.
        return next.length > MAX_FLOATS ? next.slice(next.length - MAX_FLOATS) : next;
      });
      setTransactionLog((prev) => {
        const entry = {
          id,
          text: `${payload.sold} ${payload.resourceType} → +${payload.earned} cr`,
          ts: Date.now(),
        };
        const next = [entry, ...prev];
        // Bound the log so a long session doesn't grow unbounded.
        return next.length > 8 ? next.slice(0, 8) : next;
      });
    });
    return () => {
      unsub();
    };
  }, [client]);

  // Reap expired floats. The CSS keyframe handles the actual fade;
  // we drop the DOM node when the lifetime elapses so the list
  // doesn't grow unbounded across long play sessions.
  useEffect(() => {
    if (floats.length === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setFloats((prev) => prev.filter((f) => now - f.bornAtMs < FLOAT_LIFETIME_MS));
    }, 250);
    return () => {
      window.clearInterval(id);
    };
  }, [floats.length]);

  // Esc closes the panel. Mirrors the CargoPanel convention so
  // the two modals behave identically when open together.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.code !== "Escape") return;
      ev.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const sellOne = useCallback(
    (id: ResourceId, amount: number) => {
      if (!client) return;
      client.sendSell(id, amount);
    },
    [client],
  );
  const sellAll = useCallback(
    (id: ResourceId, total: number) => {
      if (!client) return;
      if (total <= 0) return;
      client.sendSell(id, total);
    },
    [client],
  );

  const rows = useMemo(() => {
    return CARGO_RESOURCE_TYPES.map((id) => {
      const invAmount = inventory?.stacks[id] ?? 0;
      const cargoAmount = cargo?.stacks[id] ?? 0;
      const total = invAmount + cargoAmount;
      return {
        id,
        total,
        invAmount,
        cargoAmount,
        price: RESOURCE_CATALOG[id].basePrice,
      };
    });
  }, [inventory, cargo]);

  if (!open) return null;

  return (
    <div
      data-testid="drift-dock-panel"
      role="dialog"
      aria-label="Dock terminal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,6,12,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          position: "relative",
          width: 760,
          maxWidth: "92vw",
          background: "#0b1018",
          border: "1px solid rgba(255,255,255,0.15)",
          padding: 16,
          fontFamily: "monospace",
          fontSize: 12,
          color: "#e6edf3",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
      >
        {/* Header row. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Dock terminal
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dock panel"
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "#e6edf3",
              padding: "4px 10px",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
            }}
          >
            Esc
          </button>
        </div>

        {/* Tabs. */}
        <div
          role="tablist"
          style={{
            display: "flex",
            gap: 8,
            borderBottom: "1px solid rgba(255,255,255,0.12)",
            marginBottom: 12,
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`drift-dock-panel-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              style={{
                background: "transparent",
                border: "none",
                color: tab === t.id ? "#7adfff" : "rgba(230,237,243,0.55)",
                padding: "6px 12px",
                cursor: t.stub ? "not-allowed" : "pointer",
                fontFamily: "monospace",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                borderBottom: tab === t.id ? "2px solid #7adfff" : "2px solid transparent",
              }}
              disabled={t.stub}
            >
              {t.label}
              {t.stub ? <span style={{ marginLeft: 6, opacity: 0.5 }}>(soon)</span> : null}
            </button>
          ))}
        </div>

        {tab === "sell" ? (
          <SellTab rows={rows} onSellOne={sellOne} onSellAll={sellAll} canSell={client !== null} />
        ) : (
          <StubTab label={tab} />
        )}

        {/* Right rail: credits counter + transaction log. */}
        <div
          data-testid="drift-dock-panel-balance"
          style={{
            position: "absolute",
            top: 60,
            right: 16,
            width: 200,
            border: "1px solid rgba(255,255,255,0.12)",
            padding: 8,
            background: "rgba(0,0,0,0.3)",
            fontSize: 11,
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 4,
              opacity: 0.85,
            }}
          >
            Credits
          </div>
          <div
            data-testid="drift-dock-panel-balance-value"
            style={{ fontSize: 18, color: "#7adfff", fontWeight: "bold" }}
          >
            {balance.toLocaleString()} cr
          </div>
          <div
            style={{
              marginTop: 12,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            Recent sales
          </div>
          <ul
            data-testid="drift-dock-panel-log"
            style={{
              listStyle: "none",
              padding: 0,
              margin: "4px 0 0",
              maxHeight: 120,
              overflowY: "auto",
            }}
          >
            {transactionLog.length === 0 ? (
              <li style={{ opacity: 0.5 }}>— no sales yet —</li>
            ) : (
              transactionLog.map((entry) => (
                <li key={entry.id} style={{ fontSize: 10, marginBottom: 2 }}>
                  {entry.text}
                </li>
              ))
            )}
          </ul>
        </div>

        {/* Floating "+N cr" texts. Positioned absolutely on top of
            the panel so they appear at the terminal regardless of
            which tab is active. The `drift-mining-float` keyframe
            is registered in `index.html` (TASK-38 setup). */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          {floats.map((f) => (
            <div
              key={f.id}
              data-testid="drift-dock-panel-float"
              style={{
                color: "#7adfff",
                fontWeight: "bold",
                fontSize: 16,
                animation: "drift-mining-float 1s ease-out forwards",
              }}
            >
              {f.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept in this file because the AGENTS.md cap
// allows ~250 lines per component, and the Sell tab + Stub tab are
// each under 100.
// ---------------------------------------------------------------------------

interface SellRow {
  id: CargoResourceType;
  total: number;
  invAmount: number;
  cargoAmount: number;
  price: number;
}

interface SellTabProps {
  rows: readonly SellRow[];
  onSellOne: (id: ResourceId, amount: number) => void;
  onSellAll: (id: ResourceId, total: number) => void;
  canSell: boolean;
}

function SellTab({ rows, onSellOne, onSellAll, canSell }: SellTabProps): React.JSX.Element {
  return (
    <div data-testid="drift-dock-panel-sell">
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 11,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.18)" }}>
            <th style={headerCell}>Resource</th>
            <th style={{ ...headerCell, textAlign: "right" }}>Price</th>
            <th style={{ ...headerCell, textAlign: "right" }}>Sellable</th>
            <th style={{ ...headerCell, textAlign: "right" }}>Earn (max)</th>
            <th style={headerCell}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const maxEarn = row.total * row.price;
            const weightPerUnit = CARGO_WEIGHT_PER_UNIT[row.id];
            return (
              <tr key={row.id} data-testid={`drift-dock-panel-row-${row.id}`}>
                <td style={cell}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      background: RESOURCE_COLOURS[row.id],
                      marginRight: 6,
                      border: "1px solid rgba(255,255,255,0.18)",
                    }}
                  />
                  {row.id}
                  <span style={{ marginLeft: 6, opacity: 0.5, fontSize: 10 }}>
                    ({weightPerUnit}u)
                  </span>
                </td>
                <td style={{ ...cell, textAlign: "right" }}>{row.price} cr</td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {row.total > 0 ? (
                    <>
                      {row.total}
                      <span style={{ opacity: 0.5, fontSize: 10, marginLeft: 6 }}>
                        ({row.invAmount}i + {row.cargoAmount}h)
                      </span>
                    </>
                  ) : (
                    <span style={{ opacity: 0.5 }}>—</span>
                  )}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {maxEarn > 0 ? `${maxEarn} cr` : "—"}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => onSellOne(row.id, 1)}
                      disabled={!canSell || row.total <= 0}
                      aria-label={`Sell 1 ${row.id}`}
                      style={actionButtonStyle(row.total > 0 && canSell)}
                    >
                      Sell 1
                    </button>
                    <button
                      type="button"
                      onClick={() => onSellAll(row.id, row.total)}
                      disabled={!canSell || row.total <= 0}
                      aria-label={`Sell all ${row.id}`}
                      style={actionButtonStyle(row.total > 0 && canSell)}
                    >
                      Sell all
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ marginTop: 12, opacity: 0.7, fontSize: 10 }}>
        Sell price = base price from the resource catalog. The catalog is the single source of
        truth; no per-station variation in v1.
      </p>
    </div>
  );
}

interface StubTabProps {
  label: TabId;
}

function StubTab({ label }: StubTabProps): React.JSX.Element {
  return (
    <div
      data-testid={`drift-dock-panel-stub-${label}`}
      style={{
        padding: "24px 12px",
        textAlign: "center",
        opacity: 0.6,
        fontSize: 11,
      }}
    >
      {label === "ships" ? "Ship purchase lands in TASK-53." : "Repair landing in TASK-53."}
    </div>
  );
}

const headerCell: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  opacity: 0.7,
};

const cell: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

function actionButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.25)",
    color: enabled ? "#e6edf3" : "rgba(230,237,243,0.3)",
    padding: "3px 8px",
    cursor: enabled ? "pointer" : "not-allowed",
    fontFamily: "monospace",
    fontSize: 10,
  };
}
