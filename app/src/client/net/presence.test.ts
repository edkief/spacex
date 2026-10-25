import { describe, it, expect, beforeEach, vi } from 'vitest';
import { presenceStore } from './presence';
import { NetworkManager } from './NetworkManager';
import * as protocol from '../../shared/protocol';

describe('PresenceStore', () => {
  beforeEach(() => {
    presenceStore.leaveAll();
  });

  it('adds players to the map', () => {
    presenceStore.join('p1', { callsign: 'Alpha' });
    expect(presenceStore.getPlayers().size).toBe(1);
    expect(presenceStore.getPlayer('p1')?.callsign).toBe('Alpha');
  });

  it('excludes the local player', () => {
    presenceStore.setLocalPlayerId('me');
    presenceStore.join('me', { callsign: 'Self' });
    expect(presenceStore.getPlayers().size).toBe(0);
  });

  it('removes players', () => {
    presenceStore.join('p1', { callsign: 'Alpha' });
    presenceStore.leave('p1');
    expect(presenceStore.getPlayers().size).toBe(0);
  });

  it('clears all players', () => {
    presenceStore.join('p1', { callsign: 'Alpha' });
    presenceStore.join('p2', { callsign: 'Beta' });
    presenceStore.leaveAll();
    expect(presenceStore.getPlayers().size).toBe(0);
  });

  it('emits update event on join', () => {
    const spy = vi.fn();
    presenceStore.on('update', spy);
    presenceStore.join('p1', { callsign: 'Alpha' });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: 'p1',
        player: expect.objectContaining({ callsign: 'Alpha' }),
      }),
    );
  });

  it('emits leave event on leave', () => {
    const spy = vi.fn();
    presenceStore.join('p1', { callsign: 'Alpha' });
    presenceStore.on('leave', spy);
    presenceStore.leave('p1');
    expect(spy).toHaveBeenCalledWith({ playerId: 'p1' });
  });
});

describe('NetworkManager Presence Integration', () => {
  let nm: NetworkManager;

  class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((err: any) => void) | null = null;
    readyState: number = 1;
    send = vi.fn();
    close = vi.fn();
    constructor(url: string) {
      setTimeout(() => {
        if (this.onopen) this.onopen!();
      }, 0);
    }
  }

  beforeEach(() => {
    presenceStore.leaveAll();
    vi.stubGlobal('WebSocket', MockWebSocket);
    nm = new NetworkManager('ws://localhost:3000');
  });

  it('handles enter_system presence', async () => {
    await nm.connect();
    const wsInstance = (nm as any).ws;

    vi.spyOn(protocol, 'decodeEnvelope').mockReturnValue({
      success: true,
      data: {
        v: 1,
        type: 'enter_system',
        payload: {
          snapshot: {
            systemId: 'sol',
            players: [
              { id: 'p1', callsign: 'Alpha', systemId: 'sol' },
              { id: 'p2', callsign: 'Beta', systemId: 'sol' },
            ],
          },
        },
      },
    });

    wsInstance.onmessage({ data: 'mock-data' });

    const players = presenceStore.getPlayers();
    expect(players.size).toBe(2);
    expect(players.get('p1')?.callsign).toBe('Alpha');
  });

  it('handles presence_join', async () => {
    await nm.connect();
    const wsInstance = (nm as any).ws;

    vi.spyOn(protocol, 'decodeEnvelope').mockReturnValue({
      success: true,
      data: {
        v: 1,
        type: 'presence_join',
        payload: { playerId: 'p3', callsign: 'Gamma' },
      },
    });

    wsInstance.onmessage({ data: 'mock-data' });

    expect(presenceStore.getPlayer('p3')?.callsign).toBe('Gamma');
  });

  it('handles presence_leave', async () => {
    await nm.connect();
    const wsInstance = (nm as any).ws;

    presenceStore.join('p1', { callsign: 'Alpha' });

    vi.spyOn(protocol, 'decodeEnvelope').mockReturnValue({
      success: true,
      data: {
        v: 1,
        type: 'presence_leave',
        payload: { playerId: 'p1' },
      },
    });

    wsInstance.onmessage({ data: 'mock-data' });

    expect(presenceStore.getPlayer('p1')).toBeUndefined();
  });
});
