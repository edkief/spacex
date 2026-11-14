import { describe, expect, it } from 'vitest';
import { CLIENT_TYPES, type ClientType } from '@shared/protocol/registry.ts';
import { admit, reduce, type ConnState } from './state.ts';

describe('connection state reducer', () => {
  it('walks connected -> hello-ok -> authenticated -> in-system', () => {
    let state: ConnState = 'connected';
    for (const [event, expected] of [
      ['hello-ok', 'hello-ok'],
      ['authenticated', 'authenticated'],
      ['joined-system', 'in-system'],
    ] as const) {
      const next = reduce(state, event);
      expect(next).toBe(expected);
      state = next!;
    }
  });

  it.each([
    ['connected', 'authenticated'],
    ['connected', 'joined-system'],
    ['hello-ok', 'hello-ok'],
    ['hello-ok', 'joined-system'],
    ['authenticated', 'authenticated'],
    ['in-system', 'joined-system'],
    ['connected', 'logged-out'],
  ] as const)('refuses %s + %s', (state, event) => {
    expect(reduce(state, event)).toBeUndefined();
  });

  it('allows logout once authenticated, and closing from anywhere but closed', () => {
    expect(reduce('authenticated', 'logged-out')).toBe('closed');
    expect(reduce('in-system', 'logged-out')).toBe('closed');
    expect(reduce('connected', 'closed')).toBe('closed');
    expect(reduce('closed', 'hello-ok')).toBeUndefined();
    expect(reduce('closed', 'closed')).toBeUndefined();
  });
});

describe('admission table', () => {
  const GAMEPLAY: ClientType[] = [
    'chat',
    'input',
    'warp',
    'interact',
    'mine',
    'sell',
    'buy_ship',
    'set_livery',
    'exit_ship',
    'enter_ship',
    'repair',
    'target_update',
  ];

  const code = (state: ConnState, type: ClientType) => {
    const result = admit(state, type);
    return result.ok ? 'ok' : result.code;
  };

  it('lets ping and pong through in every open state', () => {
    for (const state of ['connected', 'hello-ok', 'authenticated', 'in-system'] as const) {
      expect(code(state, 'ping')).toBe('ok');
      expect(code(state, 'pong')).toBe('ok');
    }
  });

  it('requires hello first, then auth, then join_system, each in exactly its state', () => {
    expect(code('connected', 'hello')).toBe('ok');
    expect(code('hello-ok', 'hello')).toBe('out-of-order');
    expect(code('connected', 'auth')).toBe('out-of-order');
    expect(code('hello-ok', 'auth')).toBe('ok');
    expect(code('authenticated', 'auth')).toBe('out-of-order');
    expect(code('hello-ok', 'join_system')).toBe('unauthenticated');
    expect(code('authenticated', 'join_system')).toBe('ok');
    expect(code('in-system', 'join_system')).toBe('out-of-order');
  });

  it('rejects every gameplay message before login as unauthenticated', () => {
    for (const type of GAMEPLAY) {
      expect(code('connected', type)).toBe('unauthenticated');
      expect(code('hello-ok', type)).toBe('unauthenticated');
    }
    expect(code('connected', 'logout')).toBe('unauthenticated');
  });

  it('allows gameplay only inside a system', () => {
    for (const type of GAMEPLAY) {
      expect(code('authenticated', type)).toBe('out-of-order');
      expect(code('in-system', type)).toBe('ok');
    }
    expect(code('authenticated', 'logout')).toBe('ok');
  });

  it('refuses everything once closed and classifies every type', () => {
    for (const type of CLIENT_TYPES) expect(code('closed', type)).toBe('out-of-order');
    for (const state of ['connected', 'hello-ok', 'authenticated', 'in-system'] as const) {
      for (const type of CLIENT_TYPES)
        expect(['ok', 'unauthenticated', 'out-of-order']).toContain(code(state, type));
    }
  });
});
