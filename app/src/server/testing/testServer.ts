import type { AddressInfo } from 'node:net';
import { loadConfig, type ServerConfig } from '../config.ts';
import { buildServer, type DriftServer } from '../app.ts';
import type { Authenticator } from '../auth/types.ts';
import { createGalaxyDirectory, type SystemDirectory } from '../directory.ts';
import { FakeTimers } from './fakeTimers.ts';
import { createStubAuthenticator } from './stubAuth.ts';
import { TestClient } from './wsClient.ts';

export const TEST_SECRET = 'a-perfectly-valid-test-secret-of-32+chars';
export const DEV_SEED = 'drift-dev-seed-001';

export const STUB_PLAYER = {
  playerId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  callsign: 'TEST-ALPHA',
  shipId: '9b2f4c1a-7d3e-4a5b-8c6d-1e2f3a4b5c6d',
  homeSystemId: '0123456789abcdef',
};

export interface TestServerOptions {
  authenticator?: Authenticator;
  directory?: SystemDirectory;
  env?: Record<string, string>;
  fakeTimers?: boolean;
}

export interface TestServer {
  app: DriftServer;
  config: ServerConfig;
  port: number;
  wsUrl: string;
  baseUrl: string;
  timers: FakeTimers;
  authenticator: Authenticator;
  connect(headers?: Record<string, string>): Promise<TestClient>;
  close(): Promise<void>;
}

/** Boots a real Fastify + ws server on an ephemeral port with injectable dependencies. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const config = loadConfig({
    SESSION_SECRET: TEST_SECRET,
    GALAXY_SEED: DEV_SEED,
    NODE_ENV: 'test',
    ...options.env,
  });
  const timers = new FakeTimers();
  const authenticator =
    options.authenticator ?? createStubAuthenticator({ 'good-token': STUB_PLAYER });
  const app = buildServer({
    config,
    authenticator,
    directory: options.directory ?? createGalaxyDirectory({ seed: DEV_SEED }),
    ...(options.fakeTimers ? { clock: timers.now, timers } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${port}${config.wsPath}`;
  return {
    app,
    config,
    port,
    wsUrl,
    baseUrl: `http://127.0.0.1:${port}`,
    timers,
    authenticator,
    connect: (headers) => TestClient.connect(wsUrl, headers),
    close: () => app.close(),
  };
}
