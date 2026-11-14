/** Ship class ids. TASK-19 builds the full catalog keyed on these. */
export const SHIP_CLASS_IDS = ['scout', 'freighter', 'interceptor'] as const;

export type ShipClassId = (typeof SHIP_CLASS_IDS)[number];
