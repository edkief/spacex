import type { ClientType } from '@shared/protocol/registry.ts';
import type { ErrorCode } from '@shared/protocol/errors.ts';

/** Connection lifecycle: connected -> hello-ok -> authenticated -> in-system -> closed. */
export type ConnState = 'connected' | 'hello-ok' | 'authenticated' | 'in-system' | 'closed';

export type ConnEvent = 'hello-ok' | 'authenticated' | 'joined-system' | 'logged-out' | 'closed';

/** The state after `event`, or undefined when the event is not allowed in `state`. */
export function reduce(state: ConnState, event: ConnEvent): ConnState | undefined {
  if (state === 'closed') return undefined;
  switch (event) {
    case 'hello-ok':
      return state === 'connected' ? 'hello-ok' : undefined;
    case 'authenticated':
      return state === 'hello-ok' ? 'authenticated' : undefined;
    case 'joined-system':
      return state === 'authenticated' ? 'in-system' : undefined;
    case 'logged-out':
      return state === 'authenticated' || state === 'in-system' ? 'closed' : undefined;
    case 'closed':
      return 'closed';
  }
}

/** The earliest state in which each client message type is admitted. */
const REQUIRED: Record<ClientType, 'any' | ConnState> = {
  hello: 'connected',
  auth: 'hello-ok',
  ping: 'any',
  pong: 'any',
  logout: 'authenticated',
  join_system: 'authenticated',
  chat: 'in-system',
  input: 'in-system',
  warp: 'in-system',
  interact: 'in-system',
  mine: 'in-system',
  sell: 'in-system',
  buy_ship: 'in-system',
  set_livery: 'in-system',
  exit_ship: 'in-system',
  enter_ship: 'in-system',
  repair: 'in-system',
  target_update: 'in-system',
};

const ORDER: ConnState[] = ['connected', 'hello-ok', 'authenticated', 'in-system'];
const EXACT_STATE_TYPES = new Set<ClientType>(['hello', 'auth', 'join_system']);

export type Admission = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Builds a denial. */
function deny(code: 'out-of-order' | 'unauthenticated'): Admission {
  return code === 'unauthenticated'
    ? { ok: false, code, message: 'authenticate first' }
    : { ok: false, code, message: 'message not allowed in the current state' };
}

/**
 * Decides whether a message of `type` may be processed in `state`. Anything that needs a login
 * before one has happened is `unauthenticated`; any other ordering violation is `out-of-order`.
 */
export function admit(state: ConnState, type: ClientType): Admission {
  if (state === 'closed') return deny('out-of-order');
  const needed = REQUIRED[type];
  if (needed === 'any') return { ok: true };
  const have = ORDER.indexOf(state);
  const loggedIn = have >= ORDER.indexOf('authenticated');
  const needsLogin = ORDER.indexOf(needed) >= ORDER.indexOf('authenticated');
  if (needsLogin && !loggedIn) return deny('unauthenticated');
  if (EXACT_STATE_TYPES.has(type)) return state === needed ? { ok: true } : deny('out-of-order');
  return have >= ORDER.indexOf(needed) ? { ok: true } : deny('out-of-order');
}
