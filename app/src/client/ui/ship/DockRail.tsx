/**
 * Dock rail — TASK-53.
 *
 * The right rail of the dock panel: the live credits counter, the
 * recent-sales log and the floating "+N cr" texts that stack on
 * every accepted sale (TASK-40).
 */
import type * as React from "react";

/** One entry of the recent-sales log. */
export interface SaleLogEntry {
  id: number;
  text: string;
}

/** One floating "+N cr" text. */
export interface SaleFloat {
  id: number;
  text: string;
}

/** Props for the dock rail. */
export interface DockRailProps {
  /** Current credit balance. */
  balance: number;
  /** The recent sales (newest first). */
  log: readonly SaleLogEntry[];
  /** The floating texts currently on screen. */
  floats: readonly SaleFloat[];
  /** Test-id prefix for the host panel. */
  testIdPrefix: string;
}

/**
 * The credits counter + sales log + floating texts.
 */
export function DockRail({ balance, log, floats, testIdPrefix }: DockRailProps): React.JSX.Element {
  return (
    <>
      <div
        data-testid={`${testIdPrefix}-balance`}
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
          data-testid={`${testIdPrefix}-balance-value`}
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
          data-testid={`${testIdPrefix}-log`}
          style={{
            listStyle: "none",
            padding: 0,
            margin: "4px 0 0",
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          {log.length === 0 ? (
            <li style={{ opacity: 0.5 }}>— no sales yet —</li>
          ) : (
            log.map((entry) => (
              <li key={entry.id} style={{ fontSize: 10, marginBottom: 2 }}>
                {entry.text}
              </li>
            ))
          )}
        </ul>
      </div>

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
            data-testid={`${testIdPrefix}-float`}
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
    </>
  );
}
