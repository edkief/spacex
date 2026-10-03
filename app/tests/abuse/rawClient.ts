import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@shared/protocol';

/**
 * TASK-67: the abuse client harness. A minimal raw-WS client with NO game
 * logic — it sends arbitrary message objects (or even arbitrary bytes) and
 * records every inbound frame and the close code, so a cheat scenario is:
 * connect, claim a test callsign (REST), attempt, assert neutralization.
 *
 * Deliberately distinct from WsTestClient (which encodes typed game frames):
 * an abuser may send malformed JSON, unknown types and oversized payloads —
 * this client must be able to express all of that.
 */

export interface AbuseEnvelope {
  v: number;
  type: string;
  payload: unknown;
}

export class RawClient {
  readonly ws: WebSocket;
  readonly messages: AbuseEnvelope[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private wake: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      // The server only ever sends JSON envelopes; a failure here is a
      // protocol bug, not an abuser condition.
      this.messages.push(JSON.parse(String(data)) as AbuseEnvelope);
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason.toString();
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

  /** Send a structured envelope (any type/payload — no validation here). */
  send(type: string, payload: unknown): void {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload } satisfies AbuseEnvelope));
  }

  /** Send arbitrary BYTES (non-JSON, oversized, garbage — the payload-abuse AC). */
  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  /** Consume the first unmatched message matching the predicate. */
  async next(
    predicate: (m: AbuseEnvelope) => boolean,
    what: string,
    ms = 5000,
  ): Promise<AbuseEnvelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what} (closed=${this.closed} code=${this.closeCode}, got: ${this.messages
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

  /** Resolve when the socket closes (or reject after `ms`). */
  waitForClose(ms = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const timer = setInterval(() => {
        if (this.closed) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('timed out waiting for close'));
        }
      }, 10);
    });
  }

  /** Count inbound frames of a type (non-destructive). */
  count(type: string): number {
    return this.messages.filter((m) => m.type === type).length;
  }

  /** Inbound error frames (all, or only one code) — non-destructive. */
  errors(code?: string): AbuseEnvelope[] {
    return this.messages.filter(
      (m) =>
        m.type === 'error' &&
        (code === undefined || (m.payload as { code?: string }).code === code),
    );
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * A depth-`depth` nested object — the deep-nesting payload-abuse probe
 * (the strict schemas reject it, so > 32 levels never reach game state).
 */
export function nestedPayload(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = {};
  for (let i = 0; i < depth; i++) obj = { deep: obj };
  return obj;
}
