import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildServer } from '@server/app';
import { loadConfig } from '@server/config';

const config = loadConfig({
  SESSION_SECRET: 'a-perfectly-valid-test-secret-of-32+chars',
  GALAXY_SEED: 'test-seed',
  NODE_ENV: 'test',
});

describe('server', () => {
  const apps: ReturnType<typeof buildServer>[] = [];

  /** Builds a server and tracks it so afterEach always closes it. */
  function track(app: ReturnType<typeof buildServer>) {
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('answers /api/health', async () => {
    const response = await track(buildServer(config)).inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, galaxySeed: 'test-seed' });
  });

  it('answers ping with pong on the WS path', async () => {
    const app = track(buildServer(config));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const client = new WebSocket(`ws://127.0.0.1:${port}${config.wsPath}`);
    await once(client, 'open');
    client.send('ping');
    const [data] = (await once(client, 'message')) as [Buffer];
    expect(data.toString()).toBe('pong');
    client.close();
  });

  it('rejects upgrades on other paths', async () => {
    const app = track(buildServer(config));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const client = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
    const [error] = (await once(client, 'error')) as [Error];
    expect(error).toBeInstanceOf(Error);
  });

  it('shuts down promptly with an open WS client', async () => {
    const app = track(buildServer(config));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}${config.wsPath}`);
    await once(client, 'open');
    const closed = once(client, 'close');
    await app.close();
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});
