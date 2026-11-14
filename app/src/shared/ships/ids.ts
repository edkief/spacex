/** Ship class ids. TASK-19 builds the full catalog keyed on these. */
export const SHIP_CLASS_IDS = ['scout', 'freighter', 'interceptor'] as const;

export type ShipClassId = (typeof SHIP_CLASS_IDS)[number];

/** Type guard for untrusted input (DB rows, network messages). */
export function isShipClassId(value: unknown): value is ShipClassId {
  return typeof value === 'string' && (SHIP_CLASS_IDS as readonly string[]).includes(value);
}
