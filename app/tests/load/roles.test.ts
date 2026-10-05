import { describe, expect, it } from 'vitest';

import { LoadClient } from './client';
import { createRoleDriver, type Vec3 } from './roles';

/**
 * TASK-18 (no-kicks gate): the foot driver's sell trip. The server
 * range-checks EVERY interact against the character's position, so while
 * the character is teleported to the pad terminal the driver must emit no
 * interact frames at all — a 1 Hz mine-tick that lands there is denied
 * with 'out-of-range' (a real client cannot hold E at that range). The
 * channel re-opens exactly when the character is back at the deposit.
 */
describe('foot driver sell trip (TASK-18 no-kicks)', () => {
  function setup() {
    const client = new LoadClient('ws://127.0.0.1:0/ws', 8, 'foot');
    const sent: Array<{ type: string; payload: unknown }> = [];
    client.send = (type: string, payload: unknown) => {
      sent.push({ type, payload });
    };
    const teleports: Vec3[] = [];
    const terminalPos: Vec3 = { x: 100, y: 0, z: 0 };
    const charHome: Vec3 = { x: 0, y: 0, z: 0 };
    const driver = createRoleDriver(client, 'foot', {
      peerCallsigns: new Set(['load-00']),
      selfCallsign: 'load-08',
      deposits: ['deposit:load1'],
      terminalPos,
      charHome,
      teleportChar: (pos) => teleports.push({ ...pos }),
    });
    driver.rejoin(); // open the mining channel
    const actions = (): string[] =>
      sent
        .filter((m) => m.type === 'interact')
        .map((m) => (m.payload as { action: string }).action);
    return { client, sent, teleports, charHome, driver, actions };
  }

  it('suppresses interact frames while the character is at the terminal, re-opens on return', async () => {
    const { client, sent, teleports, charHome, driver, actions } = setup();
    expect(actions()).toEqual(['mine-start']); // the rejoin opened the channel

    // Backpack full (40 u of 1-u iron) → teleport to the terminal and sell.
    client.emitForTesting('mining', { phase: 'active', status: 'full' });
    expect(teleports).toHaveLength(1); // character stands at the terminal
    expect(sent.some((m) => m.type === 'sell')).toBe(true);

    // A 1 Hz mine-tick would fire here — it must stay suppressed for the
    // whole terminal window (the regression: 'out-of-range' denial).
    for (const dt of [1_100, 2_300]) {
      driver.step(performance.now() + dt);
      expect(actions(), `no interact while away (t+${dt}ms)`).toEqual(['mine-start']);
    }

    // The walk-back (400 ms) re-opens the channel at the deposit.
    await new Promise((r) => setTimeout(r, 450));
    expect(teleports).toHaveLength(2);
    expect(teleports[1]).toEqual(charHome);
    expect(actions()).toEqual(['mine-start', 'mine-start']);

    // Back at the deposit: the tick flows again.
    driver.step(performance.now() + 10_000);
    expect(actions()).toEqual(['mine-start', 'mine-start', 'mine-tick']);
  });

  it('keeps ticking normally when no sell trip is in flight', () => {
    const { driver, actions } = setup();
    driver.step(performance.now() + 1_100);
    driver.step(performance.now() + 1_200); // < 1 s since the last tick: no-op
    driver.step(performance.now() + 2_200);
    expect(actions()).toEqual(['mine-start', 'mine-tick', 'mine-tick']);
  });
});
