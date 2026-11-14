import type { ShipClassId } from './ids.ts';

/**
 * Ship catalog: the single source of truth for the server sim and the client UI.
 *
 * Units: metres, seconds, kilograms, radians. Credits are integers.
 *
 * Balance rationale (the spec's arbitrary sim units scaled x2.5 for speed, so ratios between
 * classes are unchanged): surface chunks are 256 m wide, so the scout's 300 m/s crosses about one
 * chunk per second, which a streaming client can sustain at low altitude; the interceptor's
 * 450 m/s is about 1.75 chunks/s. Planets are 2,000-60,000 km in radius, so these are
 * local-manoeuvre speeds, not interplanetary cruise (TASK-22 will tune flight feel and decide how
 * long-range travel works). Acceleration reaches top speed in 3.0 s (scout), 5.0 s (freighter)
 * and 2.6 s (interceptor). Cargo `maxWeight` is kilograms of payload. `liverySlots` are the
 * three paint zones: hull, accent, trim.
 */
export interface ShipClass {
  id: ShipClassId;
  name: string;
  description: string;
  /** Empty mass in kilograms. */
  mass: number;
  /** Top speed in metres per second. */
  maxVelocity: number;
  /** Forward acceleration in metres per second squared. */
  acceleration: number;
  /** Maximum turn rate in radians per second. */
  turnRate: number;
  cargoSlots: number;
  /** Maximum payload in kilograms. */
  maxWeight: number;
  weaponMounts: { laser: 1 | 2; missiles: 0 | 4 };
  shieldCapacity: number;
  hull: number;
  /** Credits per hull point repaired. */
  repairCostPerPoint: number;
  /** Purchase price in credits (the scout is the free starter). */
  price: number;
  liverySlots: number;
}

/** Keys of ShipClass holding a single number, usable for sorting and comparison. */
export type NumericShipStat = {
  [K in keyof ShipClass]: ShipClass[K] extends number ? K : never;
}[keyof ShipClass];

/** Thrown by `shipStats` for an id that is not in the catalog. */
export class UnknownShipClassError extends Error {
  constructor(id: unknown) {
    super(`Unknown ship class: ${String(id)}`);
    this.name = 'UnknownShipClassError';
  }
}

export const SHIP_CLASSES: Readonly<Record<ShipClassId, Readonly<ShipClass>>> = {
  scout: {
    id: 'scout',
    name: 'Scout',
    description: 'Balanced all-rounder; the free starter ship.',
    mass: 20_000,
    maxVelocity: 300,
    acceleration: 100,
    turnRate: 0.8,
    cargoSlots: 4,
    maxWeight: 4_000,
    weaponMounts: { laser: 1, missiles: 0 },
    shieldCapacity: 50,
    hull: 100,
    repairCostPerPoint: 2,
    price: 0,
    liverySlots: 3,
  },
  freighter: {
    id: 'freighter',
    name: 'Freighter',
    description: 'Slow and sturdy hauler with the largest hold.',
    mass: 120_000,
    maxVelocity: 150,
    acceleration: 30,
    turnRate: 0.4,
    cargoSlots: 12,
    maxWeight: 24_000,
    weaponMounts: { laser: 1, missiles: 0 },
    shieldCapacity: 80,
    hull: 200,
    repairCostPerPoint: 3,
    price: 4_000,
    liverySlots: 3,
  },
  interceptor: {
    id: 'interceptor',
    name: 'Interceptor',
    description: 'Fast, agile fighter with twin lasers and missiles; tiny hold.',
    mass: 30_000,
    maxVelocity: 450,
    acceleration: 175,
    turnRate: 1.2,
    cargoSlots: 2,
    maxWeight: 2_000,
    weaponMounts: { laser: 2, missiles: 4 },
    shieldCapacity: 40,
    hull: 80,
    repairCostPerPoint: 4,
    price: 2_500,
    liverySlots: 3,
  },
};

/**
 * Looks up a ship class.
 * @throws UnknownShipClassError for ids outside the catalog (including inherited keys).
 */
export function shipStats(classId: string): Readonly<ShipClass> {
  if (!Object.prototype.hasOwnProperty.call(SHIP_CLASSES, classId)) {
    throw new UnknownShipClassError(classId);
  }
  return SHIP_CLASSES[classId as ShipClassId];
}

/** Total weapon mounts (lasers plus missile launchers) of a class. */
export function totalWeaponCount(classId: ShipClassId): number {
  const { laser, missiles } = shipStats(classId).weaponMounts;
  return laser + missiles;
}

/** Dock-UI price lookup in credits. */
export function shipPrice(classId: ShipClassId): number {
  return shipStats(classId).price;
}

/** Comparator for UI sorting: negative when `a` has the smaller `key` stat than `b`. */
export function compareShips(a: ShipClassId, b: ShipClassId, key: NumericShipStat): number {
  return shipStats(a)[key] - shipStats(b)[key];
}
