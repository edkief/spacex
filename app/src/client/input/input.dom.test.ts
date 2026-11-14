import { describe, expect, it } from 'vitest';
import { inputSchema } from '@shared/protocol/world.ts';
import { DEFAULT_ACTION_MAP, boundCodes } from './actionMap.ts';
import { InputPump } from './inputPump.ts';
import { KeyboardState } from './keyboardState.ts';

describe('KeyboardState', () => {
  it('maps held keys to axes with the protocol sign conventions', () => {
    const keys = new KeyboardState();
    for (const code of ['KeyW', 'KeyA', 'ArrowDown', 'KeyE', 'Space', 'KeyX']) keys.keyDown(code);
    expect(keys.sample()).toEqual({
      thrust: 1,
      yaw: 1,
      pitch: 1,
      roll: 1,
      up: 1,
      brake: true,
      fire: false,
      lock: false,
      action: 'none',
    });
    keys.keyUp('KeyW');
    keys.keyDown('KeyS');
    expect(keys.sample().thrust).toBe(-1);
  });

  it('cancels opposing keys and ignores unbound keys', () => {
    const keys = new KeyboardState();
    expect(keys.keyDown('KeyW')).toBe(true);
    expect(keys.keyDown('KeyS')).toBe(true);
    expect(keys.keyDown('KeyP')).toBe(false);
    expect(keys.sample().thrust).toBe(0);
  });

  it('latches a one-shot action until sampled, once per press', () => {
    const keys = new KeyboardState();
    keys.keyDown('KeyU');
    keys.keyUp('KeyU'); // released before the next sample: must still be delivered
    expect(keys.sample().action).toBe('undock');
    expect(keys.sample().action).toBe('none');
    keys.keyDown('KeyG');
    keys.keyDown('KeyG'); // auto-repeat
    expect(keys.sample().action).toBe('dock');
    expect(keys.sample().action).toBe('none');
  });

  it('does not fly while typing in a text field', () => {
    const keys = new KeyboardState();
    const input = document.createElement('input');
    expect(keys.keyDown('KeyW', input)).toBe(false);
    expect(keys.sample().thrust).toBe(0);
  });

  it('releases everything on window blur and detaches cleanly', () => {
    const keys = new KeyboardState();
    const detach = keys.attach(window);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(keys.sample().thrust).toBe(1);
    window.dispatchEvent(new Event('blur'));
    expect(keys.sample().thrust).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', ctrlKey: true }));
    expect(keys.sample().thrust).toBe(0); // browser shortcuts are left alone
    detach();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(keys.sample().thrust).toBe(0);
  });

  it('lists every bound key code', () => {
    expect(boundCodes(DEFAULT_ACTION_MAP).has('Space')).toBe(true);
    expect(boundCodes(DEFAULT_ACTION_MAP).size).toBe(15);
  });
});

describe('InputPump', () => {
  it('sends schema-valid inputs at the tick rate with strictly increasing seq', () => {
    const keys = new KeyboardState();
    const sent: unknown[] = [];
    let tick: (() => void) | undefined;
    let period = 0;
    let cleared = false;
    const pump = new InputPump({
      rate: 20,
      sample: () => keys.sample(),
      send: (input) => sent.push(input),
      setInterval: (callback, ms) => {
        tick = callback;
        period = ms;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    pump.start();
    pump.start();
    expect(period).toBe(50);
    keys.keyDown('KeyW');
    for (let i = 0; i < 5; i++) tick!();
    expect(sent.map((input) => (input as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5]);
    for (const input of sent) expect(inputSchema.safeParse(input).success).toBe(true);
    pump.stop();
    expect(cleared).toBe(true);
    pump.start(); // a restart (reconnect) never reuses a sequence number
    tick!();
    expect((sent.at(-1) as { seq: number }).seq).toBe(6);
    expect(pump.nextSeq).toBe(7);
  });
});
