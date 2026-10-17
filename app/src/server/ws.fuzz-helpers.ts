/**
 * Fuzz-test transport helpers (TASK-64).
 *
 * The fuzz suite under `validation-fuzz.test.ts` needs three things
 * repeatedly:
 *   1. A fresh in-process Fastify + ws server with `/api/health`.
 *   2. A ws client connection that can collect N inbound messages.
 *
 * Kept separate from `ws.fuzz-payloads.ts` (the payload catalogue) so
 * each file stays under the 200-300 line ceiling and one concern lives
 * per file.
 */
import { WebSocket as WsClient } from "ws";
import Fastify, { type FastifyInstance } from "fastify";
import { attachWs, MAX_MESSAGE_BYTES, type WsHandle } from "./ws.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

export interface FuzzHarness {
  app: FastifyInstance;
  handle: WsHandle;
  port: number;
  url: string;
}

/**
 * Start a Fastify + ws server on an ephemeral port with `/api/health`
 * wired up. Routes MUST be registered before `app.ready()` per Fastify's
 * encapsulation rules; this helper keeps the order right so a future
 * refactor doesn't accidentally lose the REST route.
 */
export async function bootFuzzHarness(): Promise<FuzzHarness> {
  const app = Fastify({ logger: false });
  app.get("/api/health", async () => ({ ok: true, galaxySeed: "DRIFT-SEED-0001" }));
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const handle = attachWs(app, "/ws", {
    maxMessageBytes: MAX_MESSAGE_BYTES,
  });
  return { app, handle, port, url: `ws://127.0.0.1:${port}/ws` };
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

/**
 * Open a client WebSocket to the harness. Resolves once the `open`
 * event fires; rejects on `error`.
 */
export function openFuzzClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Collect the next `n` text frames off `ws` and resolve with their
 * decoded UTF-8. Times out after `timeoutMs` so a regression can't
 * hang the test suite.
 */
export function collectFuzzMessages(ws: WsClient, n: number, timeoutMs = 1500): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timeout waiting for ${n} messages; got ${out.length}: ${JSON.stringify(out)}`),
      );
    }, timeoutMs);
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data).toString("utf8");
      out.push(text);
      if (out.length >= n) {
        cleanup();
        resolve(out);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}
