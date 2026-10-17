/**
 * Shared helpers for the rate-limit integration tests (TASK-65).
 *
 * Extracted from `ws.ratelimit.test.ts` so the AGENTS.md 200-300 line
 * cap stays in force on the test bodies. Each helper is a minimal copy
 * of the corresponding `ws.test.ts` helper — keeping the suites
 * independent so a future refactor doesn't accidentally couple them.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import { attachWs, type WsHandle, type WsHandleOptions } from "./ws.js";
import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Harness {
  app: FastifyInstance;
  handle: WsHandle;
  port: number;
  url: string;
}

/**
 * Start a Fastify + ws server on an ephemeral port. The default
 * resolvers (`defaultJoinResolver`, `defaultAuthResolver`) are used
 * unless the caller overrides them via `options`.
 */
export async function bootHarness(options: WsHandleOptions = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const handle = attachWs(app, "/ws", options);
  return { app, handle, port, url: `ws://127.0.0.1:${port}/ws` };
}

/**
 * Open a client WebSocket to the harness. Resolves once the `open`
 * event fires; rejects on `error`.
 */
export function openClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Collect the next `n` text frames within `timeoutMs`. Times out so a
 * regression can't hang the suite.
 */
export function collectMessages(ws: WsClient, n: number, timeoutMs = 2000): Promise<string[]> {
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

/** Collect the next `n` text frames within `timeoutMs`. */
export function collect(ws: WsClient, n: number, timeoutMs = 2000): Promise<string[]> {
  return collectMessages(ws, n, timeoutMs);
}

/** Wait until the client's `close` event fires. */
export function waitForClose(
  ws: WsClient,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString("utf8") });
    });
  });
}

/** Decode an inbound error frame and assert on its shape. */
export interface DecodedError {
  type: string;
  payload: { code: string; message: string };
}

export function decodeError(raw: string): DecodedError {
  return JSON.parse(raw) as DecodedError;
}

/** Drive a connection through hello + auth so it reaches the `joined` state. */
export async function reachJoined(
  client: WsClient,
  callsign: string,
  harness: Harness,
): Promise<void> {
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await collect(client, 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await collect(client, 1);
  client.send(encodeEnvelope("join_system", { systemId: "system-RL" }));
  await collect(client, 1);
  void harness;
}
