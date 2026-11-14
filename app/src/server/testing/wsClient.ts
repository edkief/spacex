import { once } from 'node:events';
import { WebSocket } from 'ws';

export interface Received {
  type: string;
  payload: Record<string, unknown>;
}

/** A real ws client for integration tests with an ordered inbox. */
export class TestClient {
  readonly ws: WebSocket;
  readonly inbox: Received[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];
  private closePromise: Promise<number>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) {
        const envelope = JSON.parse(data.toString('utf8')) as {
          type: string;
          payload: Received['payload'];
        };
        this.inbox.push({ type: envelope.type, payload: envelope.payload });
      }
      this.waiters.splice(0).forEach((wake) => wake());
    });
    this.closePromise = new Promise((resolve) =>
      ws.on('close', (code) => {
        this.closeCode = code;
        this.waiters.splice(0).forEach((wake) => wake());
        resolve(code);
      }),
    );
    ws.on('error', () => undefined);
  }

  /** Opens a connection; rejects with the HTTP status when the upgrade is refused. */
  static async connect(url: string, headers: Record<string, string> = {}): Promise<TestClient> {
    const ws = new WebSocket(url, { headers });
    const refused = new Promise<never>((_resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', (error) => reject(error));
    });
    await Promise.race([once(ws, 'open'), refused]);
    return new TestClient(ws);
  }

  send(type: string, payload: unknown, v = 1): void {
    this.ws.send(JSON.stringify({ v, type, payload }));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  /** Waits for the next message (any type) in arrival order. */
  async next(timeoutMs = 3000): Promise<Received> {
    const deadline = Date.now() + timeoutMs;
    while (this.inbox.length === 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for a message');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
    return this.inbox.shift() as Received;
  }

  /** Waits for the next message and asserts its type. */
  async expect(type: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    let message = await this.next(timeoutMs);
    // Heartbeat pings are background noise unless the test asked for one.
    while (message.type === 'ping' && type !== 'ping') message = await this.next(timeoutMs);
    if (message.type !== type) {
      throw new Error(`expected ${type}, got ${message.type}: ${JSON.stringify(message.payload)}`);
    }
    return message.payload;
  }

  /** Resolves with the close code once the socket closes. */
  closed(): Promise<number> {
    return this.closePromise;
  }

  close(): void {
    this.ws.close();
  }
}
