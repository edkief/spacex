/**
 * Ship catalog — the single source of truth for the three v1 ship classes.
 * Pure data + pure helpers (no imports) so the server sim and the client UI
 * render from the same numbers.
 *
 * Balance rationale (arbitrary sim units, "u"):
 * - scout:       cheap, free starter — fast enough to run, enough cargo to be
 *                useful, single laser. The "middle" of the three.
 * - interceptor: lightest, fastest, hardest-turning, glass cannon — all the
 *                weapons (2 lasers + 4 missiles) but the least hull/shield/cargo.
 * - freighter:   the tank/hauler — most cargo (12 slots / 240 u) and most
 *                hull/shield, but the slowest and least maneuverable, no missiles.
 * Prices are ascending scout (0, starter) < interceptor < freighter.
 *
 * Ids are stable contracts: TASK-22 (flight model), TASK-43 (weapons) and
 * TASK-45 (AI roster class picks) key off 'scout' | 'freighter' | 'interceptor'.
 * LiverySlots = 3 paint zones (hull, accent, trim) for TASK-21.
 */

export type ShipClassId = 'scout' | 'freighter' | 'interceptor';

export interface ShipClass {
  id: ShipClassId;
  name: string;
  description: string;
  /** Inertial mass (u). */
  mass: number;
  /** Top speed (u/s). */
  maxVelocity: number;
  /** Thrust-derived acceleration (u/s²). */
  acceleration: number;
  /** Yaw rate (rad/s). */
  turnRate: number;
  cargoSlots: number;
  /** Maximum carried cargo mass (u). */
  maxWeight: number;
  weaponMounts: {
    laser: 1 | 2;
    missiles: 0 | 4;
  };
  shieldCapacity: number;
  hull: number;
  /** Credits per hull point repaired (dock UI). */
  repairCostPerPoint: number;
  /** Purchase price in credits (starter ship is free). */
  price: number;
  liverySlots: number;
}

export const SHIP_CLASSES: Record<ShipClassId, ShipClass> = {
  scout: {
    id: 'scout',
    name: 'Sparrow Scout',
    description: 'Light, nimble starter runner. Balanced speed and cargo, one laser.',
    mass: 20,
    maxVelocity: 120,
    acceleration: 40,
    turnRate: 0.8,
    cargoSlots: 4,
    maxWeight: 40,
    weaponMounts: { laser: 1, missiles: 0 },
    shieldCapacity: 50,
    hull: 100,
    repairCostPerPoint: 2,
    price: 0,
    liverySlots: 3,
  },
  freighter: {
    id: 'freighter',
    name: 'Ox Hauler',
    description: 'Heavy hauler. The most cargo and armor in the fleet, at the price of speed.',
    mass: 120,
    maxVelocity: 60,
    acceleration: 12,
    turnRate: 0.4,
    cargoSlots: 12,
    maxWeight: 240,
    weaponMounts: { laser: 1, missiles: 0 },
    shieldCapacity: 80,
    hull: 200,
    repairCostPerPoint: 1,
    price: 4000,
    liverySlots: 3,
  },
  interceptor: {
    id: 'interceptor',
    name: 'Dagger Interceptor',
    description: 'Fast attack craft. Highest speed and a full missile load, but fragile.',
    mass: 30,
    maxVelocity: 180,
    acceleration: 70,
    turnRate: 1.2,
    cargoSlots: 2,
    maxWeight: 20,
    weaponMounts: { laser: 2, missiles: 4 },
    shieldCapacity: 40,
    hull: 80,
    repairCostPerPoint: 3,
    price: 2500,
    liverySlots: 3,
  },
};

/** Numeric stat keys usable for UI sorting via compareShips. */
export type ShipStatKey =
  | 'mass'
  | 'maxVelocity'
  | 'acceleration'
  | 'turnRate'
  | 'cargoSlots'
  | 'maxWeight'
  | 'shieldCapacity'
  | 'hull'
  | 'repairCostPerPoint'
  | 'price'
  | 'totalWeapons';

/** Thrown when a shipStats-family helper receives an unknown class id. */
export class UnknownShipClassError extends Error {
  readonly classId: string;

  constructor(classId: string) {
    super(`unknown ship class id: ${classId}`);
    this.name = 'UnknownShipClassError';
    this.classId = classId;
  }
}

/**
 * Look up a ship class by id.
 * @throws {UnknownShipClassError} for any id that is not a v1 class.
 */
export function shipStats(classId: string): ShipClass {
  const cls = SHIP_CLASSES[classId as ShipClassId];
  if (!cls) {
    throw new UnknownShipClassError(classId);
  }
  return cls;
}

/** Total weapon hardpoints on a class (lasers + missiles). */
export function totalWeaponCount(cls: ShipClass): number {
  return cls.weaponMounts.laser + cls.weaponMounts.missiles;
}

/** Purchase price lookup for the dock UI. */
export function shipPrice(classId: string): number {
  return shipStats(classId).price;
}

/**
 * Sort comparator over ship stats for UI list sorting.
 * Accepts class ids or full class objects; negative = a sorts before b.
 * @throws {UnknownShipClassError} when given an unknown class id.
 */
export function compareShips(
  a: string | ShipClass,
  b: string | ShipClass,
  key: ShipStatKey,
): number {
  const value = (c: string | ShipClass): number => {
    const cls = typeof c === 'string' ? shipStats(c) : c;
    return key === 'totalWeapons' ? totalWeaponCount(cls) : cls[key];
  };
  return value(a) - value(b);
}
