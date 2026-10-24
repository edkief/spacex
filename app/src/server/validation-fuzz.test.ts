// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from './app';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { setupWebSocketHandler } from './ws';
import { encodeMessage, decodeEnvelope } from '../shared/protocol';
import axios from 'axios';

describe('Validation Fuzzing', () => {
  let wss: WebSocketServer;
  let fastify: any;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    fastify = createApp();
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    port = (fastify.server as any).address().port;
    baseUrl = `http://localhost:${port}`;
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

  const receive = (ws: WebSocket): Promise<any> =>
    new Promise((resolve, reject) => {
      ws.once('message', (data) => resolve(decodeEnvelope(data.toString())));
      ws.once('close', () => reject(new Error('Connection closed')));
      ws.once('error', (err) => reject(err));
    });

  it('should reject 20 malformed payloads and remain healthy', async () => {
    const ws = await createClient();

    const nested = { f1: 'deep' };
    for (let i = 0; i < 30; i++) {
      (nested as any)[`level${i}`] = nested;
    }
    // Note: the above creates a circular reference, which JSON.stringify will fail on.
    // Let's actually create a deep object.
    let deep: any = { f1: 'deep' };
    for (let i = 0; i < 30; i++) {
      deep = { [`level${i}`]: deep };
    }

    const malformedPayloads = [
      // 1. Wrong type for v in envelope
      JSON.stringify({ v: '1', type: 'hello', payload: {} }),
      // 2. Wrong type for payload in envelope
      JSON.stringify({ v: 1, type: 'hello', payload: 'not-an-object' }),
      // 3. NaN in a numeric field (Input message)
      JSON.stringify({
        v: 1,
        type: 'input',
        payload: { seq: 1, thrust: NaN, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      }),
      // 4. Infinity in a numeric field (Input message)
      JSON.stringify({
        v: 1,
        type: 'input',
        payload: { seq: 1, thrust: Infinity, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      }),
      // 5. Depth-30 nesting
      JSON.stringify({ v: 1, type: 'hello', payload: deep as any }),
      // 6. 1 MB string in a field
      JSON.stringify({
        v: 1,
        type: 'chat',
        payload: { text: 'a'.repeat(1024 * 1024), channel: 'system' },
      }),
      // 7. Negative sequence in input (though not explicitly forbidden by zod, usually it's int)
      JSON.stringify({
        v: 1,
        type: 'input',
        payload: { seq: -1, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      }),
      // 8. Unknown fields (forbidden by .strict())
      JSON.stringify({ v: 1, type: 'hello', payload: { v: 1, extra: 'probe' } }),
      // 9. Missing required fields (e.g. systemId in join_system)
      JSON.stringify({ v: 1, type: 'join_system', payload: {} }),
      // 10. Null instead of string
      JSON.stringify({ v: 1, type: 'join_system', payload: { systemId: null } }),
      // 11. Array instead of object
      JSON.stringify({ v: 1, type: 'auth', payload: [] }),
      // 12. Object instead of array (EntityUpdate)
      JSON.stringify({ v: 1, type: 'entity_update', payload: { entities: {} } }),
      // 13. Invalid enum value (Chat channel)
      JSON.stringify({ v: 1, type: 'chat', payload: { text: 'hi', channel: 'invalid-channel' } }),
      // 14. String too long for chat (max 500)
      JSON.stringify({ v: 1, type: 'chat', payload: { text: 'a'.repeat(501), channel: 'system' } }),
      // 15. String too short for chat (min 1)
      JSON.stringify({ v: 1, type: 'chat', payload: { text: '', channel: 'system' } }),
      // 16. Invalid regex for set_livery color
      JSON.stringify({ v: 1, type: 'set_livery', payload: { color: 'not-a-color' } }),
      // 17. Invalid number for sell quantity (negative)
      JSON.stringify({ v: 1, type: 'sell', payload: { itemId: 'item1', quantity: -1 } }),
      // 18. Invalid number for sell quantity (not integer)
      JSON.stringify({ v: 1, type: 'sell', payload: { itemId: 'item1', quantity: 1.5 } }),
      // 19. Malformed JSON (not a JSON object)
      'this is not json',
      // 20. Empty payload when object expected
      JSON.stringify({ v: 1, type: 'auth', payload: null }),
    ];

    for (const payload of malformedPayloads) {
      ws.send(payload);
      const resp = await receive(ws);
      expect(resp.type).toBe('error');
      expect((resp.payload as any).code).toBe('invalid-message');
    }

    // Assert health endpoint still 200
    const healthResp = await axios.get(`${baseUrl}/api/health`);
    expect(healthResp.status).toBe(200);
    expect(healthResp.data).toHaveProperty('ok', true);

    // Assert a valid flow still succeeds
    ws.send(encodeMessage('hello', { v: 1 }));
    const helloResp = await receive(ws);
    expect(helloResp.type).toBe('version-ok');

    ws.send(encodeMessage('auth', { callsign: 'FuzzTester' }));

    ws.send(encodeMessage('join_system', { systemId: 'sol' }));
    const joinResp = await receive(ws);
    expect(joinResp.type).toBe('enter_system');

    ws.close();
  });
});
