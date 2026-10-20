/**
 * Ship REST helpers — TASK-53.
 *
 * Thin wrappers around the three ship endpoints the panel uses:
 *
 *   - `GET  /api/ships`         — the player's ship row (TASK-20)
 *   - `POST /api/ships/livery`   — paint persistence (TASK-21)
 *   - `POST /api/ships/repair`   — dock repair (TASK-23)
 *
 * All of them need the session bearer token; `null` token → the
 * helper resolves to `null` without hitting the network.
 */
import type { ShipClassId } from "@shared/ships.js";

import type { LiveryColors } from "./livery.js";

/** The slice of the ship row the panel renders. */
export interface ShipInfo {
  id: string;
  classId: ShipClassId;
  hull: number;
  shields: number;
  livery: LiveryColors;
  /** `docked` | `flying` | `onfoot` | `destroyed`. */
  state: string;
}

/** Result of a repair call. */
export interface RepairOutcome {
  cost: number;
  newBalance: number;
  ship: ShipInfo;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Read the player's ship row. Returns `null` on any failure. */
export async function fetchShip(token: string | null): Promise<ShipInfo | null> {
  if (token === null) return null;
  try {
    const res = await fetch("/api/ships", { headers: authHeaders(token) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ship?: Record<string, unknown> };
    const ship = body.ship;
    if (ship === undefined) return null;
    return {
      id: String(ship.id ?? ""),
      classId: String(ship.classId ?? "scout") as ShipClassId,
      hull: Number(ship.hull ?? 0),
      shields: Number(ship.shields ?? 0),
      livery: (ship.livery ?? {
        primary: "#9aa6b2",
        secondary: "#4a5568",
        accent: "#7adfff",
      }) as LiveryColors,
      state: String(ship.state ?? "flying"),
    };
  } catch {
    return null;
  }
}

/**
 * Persist a livery. Resolves to the saved ship on success, or
 * `null` when the request failed (the panel keeps the local
 * colour state so the picker never snaps back mid-interaction).
 */
export async function saveLivery(
  token: string | null,
  colors: LiveryColors,
): Promise<ShipInfo | null> {
  if (token === null) return null;
  try {
    const res = await fetch("/api/ships/livery", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ colors }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ship?: Record<string, unknown> };
    const ship = body.ship;
    if (ship === undefined) return null;
    return {
      id: String(ship.id ?? ""),
      classId: String(ship.classId ?? "scout") as ShipClassId,
      hull: Number(ship.hull ?? 0),
      shields: Number(ship.shields ?? 0),
      livery: colors,
      state: String(ship.state ?? "flying"),
    };
  } catch {
    return null;
  }
}

/**
 * Repair the ship at the dock. Resolves to the outcome (cost +
 * new balance + the repaired row) or `null` when the request was
 * rejected (not docked / not enough credits).
 */
export async function repairShip(token: string | null): Promise<RepairOutcome | null> {
  if (token === null) return null;
  try {
    const res = await fetch("/api/ships/repair", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ship?: Record<string, unknown>;
      cost?: number;
      newBalance?: number;
    };
    const ship = body.ship;
    if (ship === undefined) return null;
    return {
      cost: Number(body.cost ?? 0),
      newBalance: Number(body.newBalance ?? 0),
      ship: {
        id: String(ship.id ?? ""),
        classId: String(ship.classId ?? "scout") as ShipClassId,
        hull: Number(ship.hull ?? 0),
        shields: Number(ship.shields ?? 0),
        livery: (ship.livery ?? {
          primary: "#9aa6b2",
          secondary: "#4a5568",
          accent: "#7adfff",
        }) as LiveryColors,
        state: String(ship.state ?? "docked"),
      },
    };
  } catch {
    return null;
  }
}
