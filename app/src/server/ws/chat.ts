import type { HandlerMap } from './dispatch.ts';
import { recordViolation } from './limits.ts';

/** Chat: limit check first (violations escalate to a drop), then broadcast within the system. */
export const chatHandlers: HandlerMap = {
  chat({ conn, deps, hub }, payload) {
    const session = conn.session;
    const systemId = conn.systemId;
    if (!session || !systemId) return;
    const verdict = conn.limits.chat.check();
    if (!verdict.ok) {
      if (!recordViolation(conn)) {
        const why =
          verdict.reason === 'too-fast' ? 'one chat message per 2 s' : '10 chat messages per 30 s';
        conn.sendError('rate-limited', why);
      }
      return;
    }
    const message = { from: session.callsign, text: payload.text, at: deps.clock() };
    for (const target of hub.inSystem(systemId)) target.send('chat', message);
  },
};
