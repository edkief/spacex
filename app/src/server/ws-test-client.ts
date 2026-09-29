import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@shared/protocol';

/**
 * Minimal WS test client for server integration tests (ship-swap, livery).
 * Buffers envelopes and exposes `next(predicate)` for ordered assertions.
 */
export interface WsEnvelope {
  v: number;
  type: string;
  payload: unknown;
}

export class WsTestClient {
  readonly ws: WebSocket;
  readonly messages: WsEnvelope[] = [];
  closed = false;
  private wake: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as WsEnvelope);
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: WsEnvelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  /** Consume the first unmatched message matching the predicate. */
  async next(predicate: (m: WsEnvelope) => boolean, what: string, ms = 3000): Promise<WsEnvelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what} (closed=${this.closed}, got: ${this.messages
            .map((m) => m.type)
            .join(',')})`,
        );
      }
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

/** Run the handshake (hello → auth → join_system) and wait for enter_system. */
export async function joinSystem(
  client: WsTestClient,
  token: string,
  systemId: string,
): Promise<void> {
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
  client.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } });
  client.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId } });
  await client.next((m) => m.type === 'enter_system', 'enter_system');
}
