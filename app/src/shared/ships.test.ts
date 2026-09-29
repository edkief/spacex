import { describe, expect, it } from 'vitest';
import {
  SHIP_CLASSES,
  UnknownShipClassError,
  compareShips,
  shipPrice,
  shipStats,
  totalWeaponCount,
  type ShipClass,
  type ShipClassId,
} from './ships';

const IDS: ShipClassId[] = ['scout', 'freighter', 'interceptor'];

const POSITIVE_STAT_KEYS = [
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
] as const;

describe('SHIP_CLASSES', () => {
  it('has exactly the three v1 classes', () => {
    expect(Object.keys(SHIP_CLASSES).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      expect(SHIP_CLASSES[id].id).toBe(id);
    }
  });

  it('has non-empty name and description per class', () => {
    for (const cls of Object.values(SHIP_CLASSES)) {
      expect(cls.name.length).toBeGreaterThan(0);
      expect(cls.description.length).toBeGreaterThan(0);
    }
  });

  it('has positive finite stats and at least one cargo slot', () => {
    for (const cls of Object.values(SHIP_CLASSES)) {
      for (const key of POSITIVE_STAT_KEYS) {
        const v = cls[key];
        expect(Number.isFinite(v), `${cls.id}.${key}`).toBe(true);
        expect(v > 0, `${cls.id}.${key}`).toBe(true);
      }
      expect(cls.cargoSlots >= 1, `${cls.id}.cargoSlots`).toBe(true);
      expect(cls.price >= 0, `${cls.id}.price`).toBe(true);
      expect(Number.isFinite(cls.price)).toBe(true);
    }
  });

  it('has 3 livery paint zones per class', () => {
    for (const cls of Object.values(SHIP_CLASSES)) {
      expect(cls.liverySlots).toBe(3);
    }
  });
});

describe('balance invariants', () => {
  const byId = (id: ShipClassId): ShipClass => SHIP_CLASSES[id];

  it('freighter has the most cargo and the lowest speed', () => {
    const [scout, freighter, interceptor] = IDS.map(byId);
    expect(freighter.cargoSlots).toBeGreaterThan(scout.cargoSlots);
    expect(freighter.cargoSlots).toBeGreaterThan(interceptor.cargoSlots);
    expect(freighter.maxWeight).toBeGreaterThan(scout.maxWeight);
    expect(freighter.maxWeight).toBeGreaterThan(interceptor.maxWeight);
    expect(freighter.maxVelocity).toBeLessThan(scout.maxVelocity);
    expect(freighter.maxVelocity).toBeLessThan(interceptor.maxVelocity);
  });

  it('interceptor has the highest speed and the missiles', () => {
    const [scout, freighter, interceptor] = IDS.map(byId);
    expect(interceptor.maxVelocity).toBeGreaterThan(scout.maxVelocity);
    expect(interceptor.maxVelocity).toBeGreaterThan(freighter.maxVelocity);
    expect(interceptor.weaponMounts.missiles).toBe(4);
    expect(scout.weaponMounts.missiles).toBe(0);
    expect(freighter.weaponMounts.missiles).toBe(0);
  });

  it('scout is the middle starter', () => {
    const [scout, freighter, interceptor] = IDS.map(byId);
    expect(scout.price).toBe(0);
    expect(scout.maxVelocity).toBeGreaterThan(freighter.maxVelocity);
    expect(scout.maxVelocity).toBeLessThan(interceptor.maxVelocity);
    expect(scout.cargoSlots).toBeLessThan(freighter.cargoSlots);
    expect(scout.cargoSlots).toBeGreaterThan(interceptor.cargoSlots);
  });

  it('prices are ascending scout < interceptor < freighter', () => {
    expect(shipStats('scout').price).toBeLessThan(shipStats('interceptor').price);
    expect(shipStats('interceptor').price).toBeLessThan(shipStats('freighter').price);
  });
});

describe('helpers', () => {
  it('shipStats returns the class for a known id', () => {
    expect(shipStats('scout')).toBe(SHIP_CLASSES.scout);
    expect(shipStats('freighter').id).toBe('freighter');
    expect(shipStats('interceptor').id).toBe('interceptor');
  });

  it('shipStats throws a typed error on unknown ids', () => {
    for (const bad of ['dreadnought', '', 'Scout', 42 as unknown as string]) {
      expect(() => shipStats(bad)).toThrow(UnknownShipClassError);
      expect(() => shipStats(bad)).toThrow(`unknown ship class id: ${bad}`);
      try {
        shipStats(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownShipClassError);
        expect((err as UnknownShipClassError).classId).toBe(bad);
      }
    }
  });

  it('totalWeaponCount sums laser and missile mounts', () => {
    expect(totalWeaponCount(SHIP_CLASSES.scout)).toBe(1);
    expect(totalWeaponCount(SHIP_CLASSES.freighter)).toBe(1);
    expect(totalWeaponCount(SHIP_CLASSES.interceptor)).toBe(6);
  });

  it('shipPrice looks up the dock price', () => {
    expect(shipPrice('scout')).toBe(0);
    expect(shipPrice('interceptor')).toBe(2500);
    expect(shipPrice('freighter')).toBe(4000);
    expect(() => shipPrice('nope')).toThrow(UnknownShipClassError);
  });

  it('compareShips orders classes by a stat key', () => {
    // by id and by object, ascending
    expect(compareShips('freighter', 'scout', 'maxVelocity') < 0).toBe(true);
    expect(compareShips('scout', 'interceptor', 'maxVelocity') < 0).toBe(true);
    expect(compareShips('scout', 'freighter', 'cargoSlots') < 0).toBe(true);
    expect(compareShips(SHIP_CLASSES.freighter, SHIP_CLASSES.scout, 'maxVelocity') < 0).toBe(true);
    expect(compareShips('interceptor', 'scout', 'totalWeapons') > 0).toBe(true);
    // stable: equal keys compare as 0
    expect(compareShips('scout', 'scout', 'price')).toBe(0);
    // descending order matches expectation for all classes
    const bySpeed = [...IDS].sort((a, b) => compareShips(a, b, 'maxVelocity'));
    expect(bySpeed).toEqual(['freighter', 'scout', 'interceptor']);
    const byPrice = [...IDS].sort((a, b) => compareShips(a, b, 'price'));
    expect(byPrice).toEqual(['scout', 'interceptor', 'freighter']);
  });

  it('compareShips throws on an unknown id', () => {
    expect(() => compareShips('ghost', 'scout', 'price')).toThrow(UnknownShipClassError);
  });
});
