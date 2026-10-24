/**
 * Ship Class Data Definitions
 *
 * Rationale for Balance:
 * - Scout: Balanced starter. Moderate everything, 0 cost.
 * - Freighter: Logistics beast. High cargo/hull, very slow, expensive.
 * - Interceptor: Combat specialist. Highest speed/turn/weaponry, fragile, mid-price.
 *
 * Units:
 * - mass: kg (sim units)
 * - maxVelocity: u/s
 * - acceleration: u/s²
 * - turnRate: rad/s
 * - price: credits
 */

export type ShipClassId = 'scout' | 'freighter' | 'interceptor';

export interface Livery {
  hull: string;
  accent: string;
  trim: string;
}

export interface ShipClass {
  id: ShipClassId;
  name: string;
  description: string;
  mass: number;
  maxVelocity: number;
  acceleration: number;
  turnRate: number;
  cargoSlots: number;
  maxWeight: number;
  weaponMounts: {
    laser: number;
    missiles: number;
  };
  shieldCapacity: number;
  hull: number;
  repairCostPerPoint: number;
  price: number;
  liverySlots: number;
}

export const SHIP_CLASSES: Record<ShipClassId, ShipClass & { defaultLivery: Livery }> = {
  scout: {
    id: 'scout',
    name: 'Scout',
    description: 'Light, fast reconnaissance vessel. Perfect for explorers.',
    mass: 20,
    maxVelocity: 120,
    acceleration: 40,
    turnRate: 0.8,
    cargoSlots: 4,
    maxWeight: 40,
    weaponMounts: { laser: 1, missiles: 0 },
    shieldCapacity: 50,
    hull: 100,
    repairCostPerPoint: 10,
    price: 0,
    liverySlots: 3,
    defaultLivery: { hull: '#cccccc', accent: '#ff0000', trim: '#333333' },
  },
  freighter: {
    id: 'freighter',
    name: 'Freighter',
    description: 'Heavy haulage vessel. Built for cargo and endurance.',
    mass: 120,
    maxVelocity: 60,
    acceleration: 12,
    turnRate: 0.4,
    cargoSlots: 12,
    maxWeight: 240,
    weaponMounts: { laser: 1, missiles: 0 },
    shieldCapacity: 80,
    hull: 200,
    repairCostPerPoint: 15,
    price: 4000,
    liverySlots: 3,
    defaultLivery: { hull: '#888888', accent: '#0000ff', trim: '#111111' },
  },
  interceptor: {
    id: 'interceptor',
    name: 'Interceptor',
    description: 'High-performance combat craft. Deadly in a dogfight.',
    mass: 30,
    maxVelocity: 180,
    acceleration: 70,
    turnRate: 1.2,
    cargoSlots: 2,
    maxWeight: 20,
    weaponMounts: { laser: 2, missiles: 4 },
    shieldCapacity: 40,
    hull: 80,
    repairCostPerPoint: 20,
    price: 2500,
    liverySlots: 3,
    defaultLivery: { hull: '#aaaaaa', accent: '#00ff00', trim: '#222222' },
  },
};

/**
 * Returns stats for a given ship class.
 * @throws Error if classId is not recognized.
 */
export function shipStats(id: ShipClassId): ShipClass {
  const stats = SHIP_CLASSES[id];
  if (!stats) {
    throw new Error(`Unknown ship class ID: ${id}`);
  }
  return stats;
}

/**
 * Compares two ship classes by a specific property for sorting.
 */
export function compareShips(a: ShipClassId, b: ShipClassId, key: keyof ShipClass): number {
  const statsA = shipStats(a);
  const statsB = shipStats(b);

  const valA = statsA[key];
  const valB = statsB[key];

  if (typeof valA === 'number' && typeof valB === 'number') {
    return valA - valB;
  }

  if (typeof valA === 'string' && typeof valB === 'string') {
    return valA.localeCompare(valB);
  }

  return 0;
}

/**
 * Calculates total weapon mounts available on a ship class.
 */
export function totalWeaponCount(id: ShipClassId): number {
  const stats = shipStats(id);
  return stats.weaponMounts.laser + stats.weaponMounts.missiles;
}
