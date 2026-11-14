import { PROTOCOL_VERSION } from '@shared/protocol/envelope.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import type { HandlerMap } from './dispatch.ts';

export const TICK_RATE = 20;
export const SNAPSHOT_RATE = 10;

/** Handshake and session handlers: hello, auth, join_system, ping/pong. */
export const sessionHandlers: HandlerMap = {
  hello({ conn, deps }, payload) {
    if (payload.v !== PROTOCOL_VERSION) {
      conn.sendError('version-mismatch', `server speaks protocol ${PROTOCOL_VERSION}`);
      conn.close(CLOSE_CODES.versionMismatch, 'version-mismatch');
      return;
    }
    conn.transition('hello-ok');
    conn.send('welcome', {
      v: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      serverTime: deps.clock(),
    });
  },

  async auth({ conn, deps, hub }, payload) {
    const result = await deps.authenticator.authenticate(payload.token);
    if (!result.ok) {
      conn.sendError('unauthenticated', 'invalid or expired session token');
      return;
    }
    const { tokenHash } = result.session;
    if (!hub.tokenLimiter.acquire(tokenHash)) {
      conn.sendError('too-many-connections', 'too many connections for this session');
      conn.close(CLOSE_CODES.connectionLimit, 'too-many-connections');
      return;
    }
    conn.onClose(() => hub.tokenLimiter.release(tokenHash));
    if (!conn.transition('authenticated')) return;
    conn.session = result.session;
    const { playerId, callsign, shipId, homeSystemId } = result.session;
    conn.send('auth_ok', { playerId, callsign, shipId, homeSystemId });
  },

  async join_system({ conn, deps, hub }, payload) {
    const session = conn.session;
    if (!session) return;
    const joined = await deps.directory.join(payload.systemId, {
      playerId: session.playerId,
      callsign: session.callsign,
      shipId: session.shipId,
      sink: conn,
    });
    if (!joined.ok) {
      conn.sendError(joined.code, joined.message);
      return;
    }
    if (!conn.transition('joined-system')) return;
    conn.systemId = payload.systemId;
    hub.enterSystem(conn, payload.systemId);
    conn.send('enter_system', {
      systemId: payload.systemId,
      tick: joined.snapshot.tick,
      lastInputSeq: joined.snapshot.lastInputSeq,
      snapshot: joined.snapshot,
    });
  },

  /** Flight input: handed to the system's sim, which applies the latest one each tick. */
  input({ conn, deps }, payload) {
    const session = conn.session;
    if (!session || !conn.systemId) return;
    deps.directory.input(conn.systemId, session.playerId, payload);
  },

  /** Revokes the presented token (deleting its session row) and closes all its sockets (1000). */
  async logout({ conn, deps, hub }) {
    const session = conn.session;
    if (!session) return;
    await deps.authenticator.revoke(session.tokenHash);
    conn.transition('logged-out');
    hub.closeToken(session.tokenHash, CLOSE_CODES.loggedOut, 'logged-out');
  },

  ping({ conn, deps }, payload) {
    conn.send('pong', { t: payload.t });
    conn.lastSeenAt = deps.clock();
  },

  pong() {
    // Receiving any frame already refreshed lastSeenAt in the dispatcher.
  },
};
