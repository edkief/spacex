import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { quatFromAxisAngle } from '@shared/physics/vec';
import type { EntityState } from '@shared/protocol/schemas';

import {
  createInteractableRegistry,
  interactableTargetsFrom,
  nextPromptState,
  resolveInteract,
  type InteractSend,
  type PromptState,
} from './interaction';
import type { InteractableTarget } from '@shared/interaction';

/**
 * TASK-33: the client interaction system — the InteractableRegistry (the
 * ONLY dispatch site), the per-frame resolve (pre-filter + shared nearest
 * raycast), and the prompt visibility state machine (show / hide / switch,
 * emit-on-change by reference).
 */

/** Feet at the origin, facing +Z (the default facing). */
const O = { x: 0, y: 0, z: 0 };
const F = { x: 0, y: 0, z: 1 };

const target = (
  id: string,
  pos: { x: number; y: number; z: number },
  extra: Partial<InteractableTarget> = {},
): InteractableTarget => ({
  id,
  kind: 'deposit',
  pos,
  ...extra,
});

const sendMock = (): { send: InteractSend; frames: { type: string; payload: unknown }[] } => {
  const frames: { type: string; payload: unknown }[] = [];
  return {
    frames,
    send: ((type: string, payload: unknown) => {
      frames.push({ type, payload });
    }) as InteractSend,
  };
};

describe('InteractableRegistry', () => {
  it('registers one entry per kind; dispatch runs exactly the entry for the target kind', () => {
    const reg = createInteractableRegistry();
    const { send, frames } = sendMock();
    reg.dispatch(target('dep-1', F), send);
    expect(frames).toHaveLength(1);
    // TASK-38: deposits are MINED, not tapped — E down starts the 1.5 s
    // channel (the server's tick is the award authority).
    expect(frames[0]).toEqual({
      type: 'interact',
      payload: { targetId: 'dep-1', action: 'mine-start' },
    });
  });

  it('release is the E-up half: deposits end their channel, tap-only kinds are silent (TASK-38)', () => {
    const reg = createInteractableRegistry();
    const { send, frames } = sendMock();
    reg.release(target('dep-1', F), send);
    expect(frames).toEqual([{ type: 'interact', payload: { targetId: 'dep-1', action: 'mine-stop' } }]);
    // A tap-only kind (no onRelease) releases as a silent no-op…
    frames.length = 0;
    reg.release(target('ship-1', F, { kind: 'ship', callsign: 'pilot' }), send);
    expect(frames).toHaveLength(0);
    // …and so is an unknown kind (never a crash).
    reg.release(target('x-1', F, { kind: 'wreck' as never }), send);
    expect(frames).toHaveLength(0);
  });

  it('dispatching an unknown kind is a silent no-op (never a crash, never a frame)', () => {
    const reg = createInteractableRegistry();
    const { send, frames } = sendMock();
    reg.dispatch(target('x-1', F, { kind: 'wreck' as never }), send);
    expect(frames).toHaveLength(0);
  });

  it('the v1 prompts are the AC strings, and the ship prompt is OWN-ship only (pre-filter)', () => {
    const reg = createInteractableRegistry();
    const mine = target('ship-1', F, { kind: 'ship', callsign: 'pilot' });
    const theirs = target('ship-2', F, { kind: 'ship', callsign: 'other' });
    const ctx = { callsign: 'pilot' };

    // TASK-38: the deposit prompt names the resource + the HOLD (the wire
    // carries the deposit's resourceId; a target without one says 'ore').
    expect(reg.get('deposit')!.prompt(target('d', F))).toBe('Hold [E] to mine ore');
    expect(reg.get('deposit')!.prompt(target('d', F, { resourceId: 'copper' }))).toBe(
      'Hold [E] to mine copper',
    );
    expect(reg.get('ship')!.prompt(mine)).toBe('[E] Enter ship');
    expect(reg.get('terminal')!.prompt(target('t', F, { kind: 'terminal' }))).toBe(
      '[E] Dock terminal',
    );

    expect(reg.get('ship')!.eligible(mine, ctx)).toBe(true);
    expect(reg.get('ship')!.eligible(theirs, ctx)).toBe(false);
    expect(reg.get('deposit')!.eligible(target('d', F), ctx)).toBe(true);
  });

  it('dispatching the ship entry sends the enter_ship message (TASK-35), not interact', () => {
    const reg = createInteractableRegistry();
    const { send, frames } = sendMock();
    reg.dispatch(target('ship-1', F, { kind: 'ship', callsign: 'pilot' }), send);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: 'enter_ship', payload: { shipId: 'ship-1' } });
  });
});

describe('resolveInteract (per-frame raycast)', () => {
  const reg = createInteractableRegistry();
  const ctx = { callsign: 'pilot' };

  it('shows the nearest eligible target with its prompt text', () => {
    const near = target('dep-near', { x: 0, y: 0, z: 1 });
    const far = target('dep-far', { x: 0, y: 0, z: 2.9 });
    const r = resolveInteract([far, near], O, undefined, ctx, reg);
    expect(r?.target.id).toBe('dep-near');
    expect(r?.text).toBe('Hold [E] to mine ore');
    expect(r?.distance).toBeCloseTo(1, 10);
  });

  it('the pre-filter hides ineligible targets even when they are the nearest (own-ship only)', () => {
    const theirs = target(
      'ship-theirs',
      { x: 0, y: 0, z: 0.5 },
      { kind: 'ship', callsign: 'other' },
    );
    const mine = target('ship-mine', { x: 0, y: 0, z: 2 }, { kind: 'ship', callsign: 'pilot' });
    const r = resolveInteract([theirs, mine], O, undefined, ctx, reg);
    expect(r?.target.id).toBe('ship-mine');
    expect(r?.text).toBe('[E] Enter ship');
    // With only the foreign ship in range: nothing (the prompt NEVER shows
    // an invalid target — the server would reject it anyway).
    expect(resolveInteract([theirs], O, undefined, ctx, reg)).toBeNull();
  });

  it('respects range and cone against the FACEING (yaw rotates the cone)', () => {
    const reg2 = reg;
    // Behind the character (facing +Z) → hidden…
    expect(
      resolveInteract([target('d', { x: 0, y: 0, z: -1 })], O, undefined, ctx, reg2),
    ).toBeNull();
    // …but "in front" once the character has yawed 180° (facing -Z).
    const pi = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);
    expect(resolveInteract([target('d', { x: 0, y: 0, z: -1 })], O, pi, ctx, reg2)?.target.id).toBe(
      'd',
    );
    // 4 m ahead → out of the 3 m reach (deposits keep the default).
    expect(
      resolveInteract([target('d', { x: 0, y: 0, z: 4 })], O, undefined, ctx, reg2),
    ).toBeNull();
  });

  it('the ship gets the 5 m enter radius (TASK-35): 4 m resolves, 5 m is inclusive, >5 m is not', () => {
    const reg2 = reg;
    const shipAt = (z: number) =>
      resolveInteract(
        [target('ship', { x: 0, y: 0, z }, { kind: 'ship', callsign: 'pilot' })],
        O,
        undefined,
        ctx,
        reg2,
      );
    expect(shipAt(4)?.target.id).toBe('ship'); // 4 m: beyond the 3 m default, inside 5
    expect(shipAt(5)?.target.id).toBe('ship'); // exactly 5 m (inclusive)
    expect(shipAt(5.001)).toBeNull();
    // …and the same 4 m deposit is still out of reach (per-kind reach).
    expect(
      resolveInteract([target('d', { x: 0, y: 0, z: 4 })], O, undefined, ctx, reg2),
    ).toBeNull();
  });

  it('ignores non-interactable entities in the target list (defensive)', () => {
    const reg2 = reg;
    const r = resolveInteract(
      [target('chr', F, { kind: 'character' as never })],
      O,
      undefined,
      ctx,
      reg2,
    );
    expect(r).toBeNull();
  });
});

describe('interactableTargetsFrom (snapshot → sparse target list)', () => {
  const e = (over: Partial<EntityState> & { id: string; kind: string }): EntityState =>
    ({
      pos: { x: 0, y: 0, z: 1 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'sublight',
      hull: 1,
      shields: 1,
      ...over,
    }) as EntityState;

  it('keeps deposits / ships / terminals (with callsigns), drops everything else', () => {
    const list = interactableTargetsFrom([
      e({ id: 'dep-1', kind: 'deposit', quantity: 7 }),
      e({ id: 'ship-1', kind: 'ship', callsign: 'pilot' }),
      e({ id: 'term-1', kind: 'terminal' }),
      e({ id: 'char-1', kind: 'character', callsign: 'pilot' }),
      e({ id: 'ai-1', kind: 'ai-ship' }),
      e({ id: 'wreck-1', kind: 'wreck' }),
    ]);
    expect(list.map((t) => t.id)).toEqual(['dep-1', 'ship-1', 'term-1']);
    expect(list.find((t) => t.id === 'ship-1')?.callsign).toBe('pilot');
    expect(list.find((t) => t.id === 'dep-1')?.callsign).toBeUndefined();
  });

  it('an empty batch yields an empty list (nothing to show)', () => {
    expect(interactableTargetsFrom([])).toEqual([]);
  });
});

describe('nextPromptState (show / hide / switch, emit-on-change)', () => {
  const resolved = (id: string, text: string) => ({
    target: target(id, F),
    text,
    distance: 1,
  });
  const HIDDEN: PromptState = { kind: 'hidden' };

  it('hidden → visible on the first hit', () => {
    const next = nextPromptState(HIDDEN, resolved('dep-1', '[E] Take ore'));
    expect(next).toEqual({ kind: 'visible', targetId: 'dep-1', text: '[E] Take ore' });
  });

  it('the SAME state object is returned while nothing changes (no re-render)', () => {
    const a = nextPromptState(HIDDEN, resolved('dep-1', '[E] Take ore'));
    const b = nextPromptState(a, resolved('dep-1', '[E] Take ore'));
    expect(b).toBe(a);
  });

  it('visible → hidden when the target walks out of range (a fresh HIDDEN)', () => {
    const a = nextPromptState(HIDDEN, resolved('dep-1', '[E] Take ore'));
    const b = nextPromptState(a, null);
    expect(b.kind).toBe('hidden');
    expect(b).not.toBe(a);
    // Staying hidden stays the SAME object (still no re-render).
    expect(nextPromptState(b, null)).toBe(b);
  });

  it('switches between two targets and back (walk left / right of two deposits)', () => {
    const a = nextPromptState(HIDDEN, resolved('dep-1', '[E] Take ore'));
    const b = nextPromptState(a, resolved('dep-2', '[E] Take ore'));
    expect(b).toEqual({ kind: 'visible', targetId: 'dep-2', text: '[E] Take ore' });
    expect(b).not.toBe(a);
    const c = nextPromptState(b, resolved('dep-1', '[E] Take ore'));
    expect(c).toEqual({ kind: 'visible', targetId: 'dep-1', text: '[E] Take ore' });
  });
});

describe('registry-only dispatch (the lint-style AC)', () => {
  it('no file in src/client but input/interaction.ts constructs an interaction frame', () => {
    const clientDir = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (file === path.join(clientDir, 'input', 'interaction.ts')) continue;
        const src = fs.readFileSync(file, 'utf8');
        // A dispatch site is where an interaction message type ('interact'
        // for deposits/terminals, 'enter_ship' for ships — TASK-35) is used
        // with a send (the registry's onInteract callbacks are the only ones).
        if (/\bsend\(\s*['"](interact|enter_ship)['"]/.test(src)) {
          offenders.push(path.relative(clientDir, file));
        }
      }
    };
    walk(clientDir);
    expect(offenders).toEqual([]);
  });
});
