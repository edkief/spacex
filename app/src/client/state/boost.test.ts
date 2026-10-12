/**
 * TASK-108: the boost toggle store (the client-side cruise boost state).
 *
 * The docked.ts subscribe/emit idiom: set → emit ONLY on change (the HUD
 * re-renders stay cheap), late subscribers catch up, and the auto-disengage
 * predicate (the wire regime left SPACE, or egress) force-offers the store —
 * the same expression main.tsx applies to every self entity_update.
 *
 * The payload tests mirror the FLIGHT LOOP's exact composition (the loop
 * body in main.tsx): `readSchemeInput(scheme, pressed)` → while the store is
 * on, `input.boost = 1` → `shipInputToPayload`. That is the whole client
 * half of the feature: toggle ON ⇒ the 'boost' tag rides the next frame with
 * NO key held; toggle OFF ⇒ the legacy byte-identical path (held Shift =
 * boost, nothing held = nothing).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { readSchemeInput, CONTROL_SCHEMES } from '@client/input/controls';
import { shipInputToPayload } from '@shared/protocol/inputs';
import {
  __resetBoost,
  boostAllowed,
  boostAutoDisengage,
  boostOn,
  boostOnSubscribe,
  setBoostOn,
  toggleBoost,
} from './boost';

afterEach(() => {
  __resetBoost();
});

describe('boost store (TASK-108)', () => {
  it('starts off; setBoostOn(true) emits exactly once, setBoostOn(false) emits once', () => {
    const seen: boolean[] = [];
    const off = boostOnSubscribe((v) => seen.push(v));
    expect(seen).toEqual([false]); // late subscribers catch up
    setBoostOn(true);
    setBoostOn(true); // same value → NO second emit (emit-on-change)
    setBoostOn(false);
    off();
    expect(seen).toEqual([false, true, false]);
  });

  it('setBoostOn with the current value is a no-op (no re-emit)', () => {
    const seen: boolean[] = [];
    const off = boostOnSubscribe((v) => seen.push(v));
    setBoostOn(false); // already false
    off();
    expect(seen).toEqual([false]);
  });

  it('toggleBoost flips both ways', () => {
    expect(boostOn()).toBe(false);
    toggleBoost();
    expect(boostOn()).toBe(true);
    toggleBoost();
    expect(boostOn()).toBe(false);
  });

  it('unsubscribed listeners stop receiving (and re-subscribing catches up)', () => {
    const seen: boolean[] = [];
    const off = boostOnSubscribe((v) => seen.push(v));
    toggleBoost();
    off();
    toggleBoost(); // nobody listens
    const again = boostOnSubscribe((v) => seen.push(v));
    again();
    expect(seen).toEqual([false, true, false]);
  });
});

describe('boost regime gating (pure predicates)', () => {
  it('allowed in space while in the ship', () => {
    expect(boostAllowed('space', false)).toBe(true);
    expect(boostAutoDisengage('space', false)).toBe(false);
  });

  it('NOT allowed in atmosphere or surface (the cruise physics is a no-op there)', () => {
    expect(boostAllowed('atmosphere', false)).toBe(false);
    expect(boostAllowed('surface', false)).toBe(false);
    expect(boostAutoDisengage('atmosphere', false)).toBe(true);
    expect(boostAutoDisengage('surface', false)).toBe(true);
  });

  it('NOT allowed on foot (a character has no boost)', () => {
    expect(boostAllowed('space', true)).toBe(false);
    expect(boostAutoDisengage('space', true)).toBe(true);
  });
});

describe('boost auto-disengage (the main.tsx entity_update path)', () => {
  /** The exact expression main.tsx runs on every self entity_update. */
  const onSelfUpdate = (regime: string, onFoot: boolean): void => {
    if (boostAutoDisengage(regime, onFoot)) setBoostOn(false);
  };

  it('boost on survives space frames (no false disengage)', () => {
    setBoostOn(true);
    onSelfUpdate('space', false);
    expect(boostOn()).toBe(true);
  });

  it('the wire regime leaving space (atmosphere) force-offers', () => {
    setBoostOn(true);
    const seen: boolean[] = [];
    const off = boostOnSubscribe((v) => seen.push(v));
    onSelfUpdate('atmosphere', false);
    off();
    expect(boostOn()).toBe(false);
    expect(seen).toEqual([true, false]); // one emit, on the disengage
  });

  it('egress (self becomes the character) force-offers', () => {
    setBoostOn(true);
    onSelfUpdate('space', true);
    expect(boostOn()).toBe(false);
  });

  it('a re-engage after a disengage works (toggle on again in space)', () => {
    setBoostOn(true);
    onSelfUpdate('atmosphere', false);
    expect(boostOn()).toBe(false); // re-entering space starts OFF (owner decision)
    onSelfUpdate('space', false);
    expect(boostOn()).toBe(false);
    toggleBoost();
    expect(boostOn()).toBe(true);
    onSelfUpdate('space', false);
    expect(boostOn()).toBe(true);
  });
});

/**
 * The flight loop's exact composition (main.tsx): read the scheme input for
 * the pressed keys, let the store override the boost demand while on, then
 * map to the wire payload.
 */
function loopPayload(pressed: ReadonlySet<string>): { action?: string; boost?: number } {
  const input = readSchemeInput(CONTROL_SCHEMES.space, pressed);
  if (boostOn()) {
    input.boost = 1;
  }
  const payload = shipInputToPayload(1, input);
  return { action: payload.action, boost: input.boost };
}

describe('boost toggle → wire payload (the flight loop composition)', () => {
  it('toggle ON, NO key held: the payload carries the boost tag (sustained demand)', () => {
    toggleBoost();
    expect(loopPayload(new Set()).action).toBe('boost');
  });

  it('toggle ON beats the key readout: no Shift in the set, demand is 1', () => {
    toggleBoost();
    expect(loopPayload(new Set()).boost).toBe(1);
    // …and with W held the tags combine (thrust + boost), like the legacy
    // W+Shift frame.
    expect(loopPayload(new Set(['w'])).action).toBe('boost');
  });

  it('toggle OFF: no tag with no keys (byte-identical idle frame)', () => {
    toggleBoost();
    toggleBoost();
    expect(loopPayload(new Set()).action).toBeUndefined();
  });

  it('regime leaves space → the store force-offers and the tag is gone', () => {
    toggleBoost();
    expect(boostOn()).toBe(true);
    // The main.tsx expression on the regime flip:
    if (boostAutoDisengage('atmosphere', false)) setBoostOn(false);
    expect(boostOn()).toBe(false);
    expect(loopPayload(new Set()).action).toBeUndefined();
  });

  it('LEGACY: store OFF + Shift held ⇒ the boost tag (byte-identical to pre-change)', () => {
    expect(boostOn()).toBe(false);
    expect(loopPayload(new Set(['Shift'])).action).toBe('boost');
    const payload = shipInputToPayload(
      1,
      (() => {
        const input = readSchemeInput(CONTROL_SCHEMES.space, new Set(['Shift', 'w']));
        if (boostOn()) input.boost = 1;
        return input;
      })(),
    );
    // Exactly the pre-task W+Shift frame: thrust 1, boost tag, nothing else.
    expect(payload).toEqual({
      seq: 1,
      thrust: 1,
      yaw: 0,
      pitch: 0,
      turn: 0,
      fire: false,
      lock: false,
      action: 'boost',
    });
  });
});
