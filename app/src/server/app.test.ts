import { afterEach, describe, expect, it } from 'vitest';
import { TestClient } from './testing/wsClient.ts';
import { startTestServer, type TestServer } from './testing/testServer.ts';

describe('server', () => {
  const servers: TestServer[] = [];

  /** Starts a server and tracks it so afterEach always closes it. */
  async function start(): Promise<TestServer> {
    const server = await startTestServer();
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('answers /api/health', async () => {
    const { app } = await start();
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, galaxySeed: 'drift-dev-seed-001' });
  });

  it('rejects upgrades on other paths', async () => {
    const server = await start();
    await expect(TestClient.connect(`ws://127.0.0.1:${server.port}/not-ws`)).rejects.toThrow();
  });

  it('shuts down promptly with an open WS client', async () => {
    const server = await start();
    const client = await server.connect();
    await server.close();
    expect(await client.closed()).toBeGreaterThan(0);
  });
});
