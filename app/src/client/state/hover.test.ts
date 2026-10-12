/**
 * TASK-107: the hover toggle store (the client-side VTOL hover state).
 *
 * The docked.ts subscribe/emit idiom: set → emit ONLY on change (the HUD
 * re-renders stay cheap), late subscribers catch up, and the auto-disengage
 * predicate (the wire regime left atmosphere/surface, or egress) force-
 * offers the store — the same expression main.tsx applies to every self
 * entity_update.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetHover,
  hoverAllowed,
  hoverAutoDisengage,
  hoverOn,
  hoverOnSubscribe,
  setHoverOn,
  toggleHover,
} from './hover';

afterEach(() => {
  __resetHover();
});

describe('hover store (TASK-107)', () => {
  it('starts off; setHoverOn(true) emits exactly once, setHoverOn(false) emits once', () => {
    const seen: boolean[] = [];
    const off = hoverOnSubscribe((v) => seen.push(v));
    expect(seen).toEqual([false]); // late subscribers catch up
    setHoverOn(true);
    setHoverOn(true); // same value → NO second emit (emit-on-change)
    setHoverOn(false);
    off();
    expect(seen).toEqual([false, true, false]);
  });

  it('setHoverOn with the current value is a no-op (no re-emit)', () => {
    const seen: boolean[] = [];
    const off = hoverOnSubscribe((v) => seen.push(v));
    setHoverOn(false); // already false
    off();
    expect(seen).toEqual([false]);
  });

  it('toggleHover flips both ways', () => {
    expect(hoverOn()).toBe(false);
    toggleHover();
    expect(hoverOn()).toBe(true);
    toggleHover();
    expect(hoverOn()).toBe(false);
  });

  it('unsubscribed listeners stop receiving (and re-subscribing catches up)', () => {
    const seen: boolean[] = [];
    const off = hoverOnSubscribe((v) => seen.push(v));
    toggleHover();
    off();
    toggleHover(); // nobody listens
    const again = hoverOnSubscribe((v) => seen.push(v));
    again();
    expect(seen).toEqual([false, true, false]);
  });
});

describe('hover regime gating (pure predicates)', () => {
  it('allowed in atmosphere and surface while in the ship', () => {
    expect(hoverAllowed('atmosphere', false)).toBe(true);
    expect(hoverAllowed('surface', false)).toBe(true);
    expect(hoverAutoDisengage('atmosphere', false)).toBe(false);
    expect(hoverAutoDisengage('surface', false)).toBe(false);
  });

  it('NOT allowed in space (the physics branch is unreachable)', () => {
    expect(hoverAllowed('space', false)).toBe(false);
    expect(hoverAutoDisengage('space', false)).toBe(true);
  });

  it('NOT allowed on foot (a character has no hover)', () => {
    expect(hoverAllowed('surface', true)).toBe(false);
    expect(hoverAllowed('atmosphere', true)).toBe(false);
    expect(hoverAutoDisengage('surface', true)).toBe(true);
  });
});

describe('hover auto-disengage (the main.tsx entity_update path)', () => {
  /** The exact expression main.tsx runs on every self entity_update. */
  const onSelfUpdate = (regime: string, onFoot: boolean): void => {
    if (hoverAutoDisengage(regime, onFoot)) setHoverOn(false);
  };

  it('hover on survives atmosphere/surface frames (no false disengage)', () => {
    setHoverOn(true);
    onSelfUpdate('atmosphere', false);
    onSelfUpdate('surface', false);
    expect(hoverOn()).toBe(true);
  });

  it('the wire regime leaving atmosphere/surface (space) force-offers', () => {
    setHoverOn(true);
    const seen: boolean[] = [];
    const off = hoverOnSubscribe((v) => seen.push(v));
    onSelfUpdate('space', false);
    off();
    expect(hoverOn()).toBe(false);
    expect(seen).toEqual([true, false]); // one emit, on the disengage
  });

  it('egress (self becomes the character) force-offers even on the surface', () => {
    setHoverOn(true);
    onSelfUpdate('surface', true);
    expect(hoverOn()).toBe(false);
  });

  it('a re-engage after a disengage works (toggle on again)', () => {
    setHoverOn(true);
    onSelfUpdate('space', false);
    expect(hoverOn()).toBe(false);
    setHoverOn(true); // back in the atmosphere (regime flips on the next frame)
    onSelfUpdate('atmosphere', false);
    expect(hoverOn()).toBe(true);
  });
});
