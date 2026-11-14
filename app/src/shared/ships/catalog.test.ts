import { describe, expect, it } from 'vitest';
import {
  SHIP_CLASSES,
  UnknownShipClassError,
  compareShips,
  shipPrice,
  shipStats,
  totalWeaponCount,
  type NumericShipStat,
} from '@shared/ships/index.ts';
import { SHIP_CLASS_IDS, isShipClassId } from '@shared/ships/ids.ts';

const NUMERIC: NumericShipStat[] = [
  'mass',
  'maxVelocity',
  'acceleration',
  'turnRate',
  'cargoSlots',
  'maxWeight',
  'shieldCapacity',
  'hull',
  'repairCostPerPoint',
  'liverySlots',
];

describe('ship catalog', () => {
  it('has exactly the three classes with matching ids', () => {
    expect(Object.keys(SHIP_CLASSES).sort()).toEqual([...SHIP_CLASS_IDS].sort());
    for (const id of SHIP_CLASS_IDS) expect(SHIP_CLASSES[id].id).toBe(id);
  });

  it.each(SHIP_CLASS_IDS)('%s has positive finite stats and sane mounts', (id) => {
    const ship = shipStats(id);
    for (const key of NUMERIC) {
      expect(Number.isFinite(ship[key]) && ship[key] > 0, `${id}.${key}`).toBe(true);
    }
    expect(Number.isFinite(ship.price) && ship.price >= 0).toBe(true);
    expect(ship.cargoSlots).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(ship.cargoSlots)).toBe(true);
    expect(Number.isInteger(ship.price)).toBe(true);
    expect([1, 2]).toContain(ship.weaponMounts.laser);
    expect([0, 4]).toContain(ship.weaponMounts.missiles);
    expect(ship.liverySlots).toBe(3);
    expect(ship.name.length).toBeGreaterThan(0);
    expect(ship.description.length).toBeGreaterThan(0);
  });

  it('keeps the balance invariants', () => {
    const { scout, freighter, interceptor } = SHIP_CLASSES;
    expect(freighter.cargoSlots).toBeGreaterThan(scout.cargoSlots);
    expect(freighter.cargoSlots).toBeGreaterThan(interceptor.cargoSlots);
    expect(freighter.maxWeight).toBeGreaterThan(scout.maxWeight);
    expect(freighter.maxVelocity).toBeLessThan(scout.maxVelocity);
    expect(freighter.maxVelocity).toBeLessThan(interceptor.maxVelocity);
    expect(interceptor.maxVelocity).toBeGreaterThan(scout.maxVelocity);
    expect(interceptor.weaponMounts.missiles).toBeGreaterThan(0);
    expect(scout.weaponMounts.missiles).toBe(0);
    expect(scout.maxVelocity).toBeGreaterThan(freighter.maxVelocity);
    expect(scout.maxVelocity).toBeLessThan(interceptor.maxVelocity);
    expect(scout.price).toBeLessThan(interceptor.price);
    expect(interceptor.price).toBeLessThan(freighter.price);
  });

  it('makes the free scout the starter', () => {
    expect(shipPrice('scout')).toBe(0);
  });

  it('reaches top speed in a few seconds', () => {
    for (const id of SHIP_CLASS_IDS) {
      const seconds = shipStats(id).maxVelocity / shipStats(id).acceleration;
      expect(seconds).toBeGreaterThan(1);
      expect(seconds).toBeLessThan(10);
    }
  });
});

describe('helpers', () => {
  it('shipStats throws a typed error for unknown or inherited ids', () => {
    for (const bad of ['', 'battleship', 'toString', '__proto__', 'constructor']) {
      expect(() => shipStats(bad)).toThrow(UnknownShipClassError);
    }
  });

  it('counts weapons', () => {
    expect(totalWeaponCount('scout')).toBe(1);
    expect(totalWeaponCount('interceptor')).toBe(6);
  });

  it('compareShips sorts by any numeric stat', () => {
    expect(compareShips('scout', 'freighter', 'maxVelocity')).toBeGreaterThan(0);
    expect(compareShips('scout', 'scout', 'hull')).toBe(0);
    const byPrice = [...SHIP_CLASS_IDS].sort((a, b) => compareShips(a, b, 'price'));
    expect(byPrice).toEqual(['scout', 'interceptor', 'freighter']);
  });

  it('isShipClassId guards untrusted values', () => {
    expect(isShipClassId('scout')).toBe(true);
    expect(isShipClassId('Scout')).toBe(false);
    expect(isShipClassId(1)).toBe(false);
  });
});
