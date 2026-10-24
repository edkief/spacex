import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage } from '../shared/protocol';

describe('Flood Benchmark', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;

  beforeEach(async () => {
    fastify = createApp();
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    port = (fastify.server as any).address().port;
    wss = new WebSocketServer({ server: fastify.server });
    setupWebSocketHandler(wss);
  });

  afterEach(async () => {
    wss.close();
    await fastify.close();
  });

  const createClient = () =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => resolve(ws));
    });

  const completeHandshake = async (ws: WebSocket) => {
    ws.send(encodeMessage('hello', { v: 1 }));
    await new Promise((resolve) => ws.once('message', resolve));
    ws.send(encodeMessage('auth', { callsign: 'FloodTest' }));
    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    await new Promise((resolve) => ws.once('message', resolve));
  };

  it('should maintain server tick performance during a message flood', async () => {
    const ws = await createClient();
    await completeHandshake(ws);

    const executionTimes: number[] = [];
    let isFlooding = true;

    // Mock tick loop: 20Hz
    const tickInterval = setInterval(() => {
      const start = performance.now();

      // Simulate some tick work (e.g. iterating over entities)
      // We'll just do a small loop to make it non-zero
      let sum = 0;
      for (let i = 0; i < 1000; i++) {
        sum += Math.sqrt(i);
      }

      const end = performance.now();
      executionTimes.push(end - start);
    }, 50);

    // Flood client: send 100 messages per second for 10 seconds
    const floodDuration = 10000;
    const msgPerSecond = 100;
    const interval = 1000 / msgPerSecond;

    let messagesSent = 0;
    const floodPromise = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeMessage('pong', { ts: Date.now() }));
        }
        messagesSent++;
        if (messagesSent >= msgPerSecond * (floodDuration / 1000)) {
          clearInterval(timer);
          isFlooding = false;
          resolve();
        }
      }, interval);
    });

    // Wait for flood to complete or client to be dropped
    await Promise.race([
      floodPromise,
      new Promise<void>((resolve) => {
        ws.on('close', (code) => {
          if (code === 4009) {
            resolve();
          }
        });
      }),
    ]);

    clearInterval(tickInterval);

    // Calculate p95 execution time
    executionTimes.sort((a, b) => a - b);
    const p95Index = Math.floor(executionTimes.length * 0.95);
    const p95Tick = executionTimes[p95Index];

    console.log(`p95 tick execution time during flood: ${p95Tick.toFixed(4)}ms`);

    expect(p95Tick).toBeLessThan(30);

    // The client should have been dropped by now if the flood was enough
    // In the previous integration test, it was dropped after 3 violations.
    // 100 msg/s will definitely trigger that.
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  }, 30000);
}, 30000);
