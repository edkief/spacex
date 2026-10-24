import { describe, it, expect } from 'vitest';
import { SHIP_CLASSES, shipStats, compareShips, totalWeaponCount, ShipClassId } from './ships';

describe('Ship Catalog', () => {
  it('should contain all three v1 ship classes', () => {
    expect(SHIP_CLASSES).toHaveProperty('scout');
    expect(SHIP_CLASSES).toHaveProperty('freighter');
    expect(SHIP_CLASSES).toHaveProperty('interceptor');
  });

  it('should have positive finite numbers for all numerical stats', () => {
    for (const ship of Object.values(SHIP_CLASSES)) {
      const numericStats = [
        ship.mass,
        ship.maxVelocity,
        ship.acceleration,
        ship.turnRate,
        ship.cargoSlots,
        ship.maxWeight,
        ship.weaponMounts.laser,
        ship.weaponMounts.missiles,
        ship.shieldCapacity,
        ship.hull,
        ship.repairCostPerPoint,
        ship.price,
        ship.liverySlots,
      ];

      numericStats.forEach((stat) => {
        expect(stat).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(stat)).toBe(true);
      });
    }
  });

  it('should have at least one cargo slot for all ships', () => {
    for (const ship of Object.values(SHIP_CLASSES)) {
      expect(ship.cargoSlots).toBeGreaterThanOrEqual(1);
    }
  });

  describe('Balance Invariants', () => {
    it('should ensure freighter has most cargo and lowest speed', () => {
      const f = SHIP_CLASSES.freighter;
      const s = SHIP_CLASSES.scout;
      const i = SHIP_CLASSES.interceptor;

      expect(f.cargoSlots).toBeGreaterThan(s.cargoSlots);
      expect(f.cargoSlots).toBeGreaterThan(i.cargoSlots);
      expect(f.maxVelocity).toBeLessThan(s.maxVelocity);
      expect(f.maxVelocity).toBeLessThan(i.maxVelocity);
    });

    it('should ensure interceptor has highest speed and most missiles', () => {
      const i = SHIP_CLASSES.interceptor;
      const s = SHIP_CLASSES.scout;
      const f = SHIP_CLASSES.freighter;

      expect(i.maxVelocity).toBeGreaterThan(s.maxVelocity);
      expect(i.maxVelocity).toBeGreaterThan(f.maxVelocity);
      expect(i.weaponMounts.missiles).toBeGreaterThan(s.weaponMounts.missiles);
      expect(i.weaponMounts.missiles).toBeGreaterThan(f.weaponMounts.missiles);
    });

    it('should ensure prices are ascending: scout < interceptor < freighter', () => {
      expect(SHIP_CLASSES.scout.price).toBeLessThan(SHIP_CLASSES.interceptor.price);
      expect(SHIP_CLASSES.interceptor.price).toBeLessThan(SHIP_CLASSES.freighter.price);
    });
  });

  describe('Helpers', () => {
    it('shipStats should return correct stats for valid id', () => {
      expect(shipStats('scout')).toEqual(SHIP_CLASSES.scout);
    });

    it('shipStats should throw on unknown id', () => {
      expect(() => shipStats('invalid' as any)).toThrow('Unknown ship class ID: invalid');
    });

    it('compareShips should correctly sort ships', () => {
      // Price: scout(0) < interceptor(2500) < freighter(4000)
      expect(compareShips('scout', 'interceptor', 'price')).toBeLessThan(0);
      expect(compareShips('interceptor', 'freighter', 'price')).toBeLessThan(0);
      expect(compareShips('freighter', 'scout', 'price')).toBeGreaterThan(0);

      // Name: Freighter < Interceptor < Scout
      expect(compareShips('freighter', 'interceptor', 'name')).toBeLessThan(0);
    });

    it('totalWeaponCount should calculate correctly', () => {
      expect(totalWeaponCount('scout')).toBe(1); // 1 laser + 0 missile
      expect(totalWeaponCount('interceptor')).toBe(6); // 2 laser + 4 missile
      expect(totalWeaponCount('freighter')).toBe(1); // 1 laser + 0 missile
    });
  });
});
