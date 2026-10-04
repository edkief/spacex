import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHIP_LOST_MS,
  __resetShipLost,
  hideShipLost,
  showShipLost,
  shipLostCurrent,
  shipLostSubscribe,
} from './ship-lost';

const T0 = 1_000_000; // a fixed clock base (the moment carries its own `at`)

afterEach(() => __resetShipLost());

describe('ship-lost moment state (TASK-49)', () => {
  it('starts hidden and subscribes with an immediate catch-up emit', () => {
    const fn = vi.fn();
    const off = shipLostSubscribe(fn);
    expect(shipLostCurrent()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(null);

    showShipLost({ callsign: 'Bravo', killer: 'Alpha', at: T0 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(shipLostCurrent()).toMatchObject({ callsign: 'Bravo', killer: 'Alpha' });

    off();
    hideShipLost();
    expect(fn).toHaveBeenCalledTimes(2); // unsubscribed → no more emits
  });

  it('show → hide cycle emits the moment then null (the overlay timer path)', () => {
    const fn = vi.fn();
    const off = shipLostSubscribe(fn);
    fn.mockClear();
    showShipLost({ callsign: 'Bravo', killer: 'Alpha', at: T0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shipLostCurrent()).toMatchObject({ at: T0 });

    hideShipLost();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(null);
    expect(shipLostCurrent()).toBeNull();
    off();
  });

  it('hideShipLost is a no-op when nothing is showing', () => {
    const fn = vi.fn();
    const off = shipLostSubscribe(fn);
    fn.mockClear();
    hideShipLost();
    expect(fn).toHaveBeenCalledTimes(0);
    off();
  });

  it('emits only on change (identical moments dedup via canonical json)', () => {
    const fn = vi.fn();
    const off = shipLostSubscribe(fn);
    fn.mockClear();
    const m = { callsign: 'Bravo', killer: 'Alpha', at: T0 };
    showShipLost(m);
    showShipLost({ ...m }); // same values → no second emit
    expect(fn).toHaveBeenCalledTimes(1);

    // A different killer (or timestamp) is a change → emits.
    showShipLost({ ...m, killer: 'Gamma' });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it('SHIP_LOST_MS is the 2 s presentation window', () => {
    expect(SHIP_LOST_MS).toBe(2_000);
  });

  it('__resetShipLost clears state and subscribers', () => {
    showShipLost({ callsign: 'Bravo', killer: 'Alpha', at: T0 });
    __resetShipLost();
    expect(shipLostCurrent()).toBeNull();
    const fn = vi.fn();
    const off = shipLostSubscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(null);
    off();
  });
});
