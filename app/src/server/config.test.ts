import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadEndpointConfig } from '@server/config';

const SECRET = 'a-perfectly-valid-test-secret-of-32+chars';
const valid = { SESSION_SECRET: SECRET };

/** Runs `fn` and returns the ConfigError it throws, failing the test if it does not throw. */
function catchConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: 'development',
      isProduction: false,
      host: '127.0.0.1',
      port: 3000,
      apiPort: 3001,
      listenPort: 3001,
      sessionSecret: SECRET,
      galaxySeed: 'drift-default-galaxy',
      dbDriver: 'sqlite',
      dbPath: './data/drift.db',
      databaseUrl: undefined,
      systemInstanceCount: 3,
      wsPath: '/ws',
    });
  });

  it('reads overrides, coercing numbers', () => {
    const config = loadConfig({
      ...valid,
      PORT: '4000',
      API_PORT: '4100',
      GALAXY_SEED: 'seed',
      DB_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      DB_PATH: '/tmp/x.db',
      SYSTEM_INSTANCE_COUNT: '5',
      WS_PATH: '/socket',
    });
    expect(config).toMatchObject({
      port: 4000,
      apiPort: 4100,
      galaxySeed: 'seed',
      dbDriver: 'postgres',
      dbPath: '/tmp/x.db',
      systemInstanceCount: 5,
      wsPath: '/socket',
    });
  });

  it('listens on PORT in production and API_PORT otherwise', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'production' }).listenPort).toBe(3000);
    expect(loadConfig(valid).listenPort).toBe(3001);
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ ...valid, PORT: '', GALAXY_SEED: '  ' })).toMatchObject({
      port: 3000,
      galaxySeed: 'drift-default-galaxy',
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { SESSION_SECRET: '' }],
    ['placeholder', { SESSION_SECRET: 'TODO_FILL_MANUALLY' }],
    ['too short', { SESSION_SECRET: 'short-secret' }],
  ])('rejects a %s SESSION_SECRET, naming the variable', (_label, env) => {
    expect(catchConfigError(() => loadConfig(env)).message).toContain('SESSION_SECRET');
  });

  it('never leaks the secret value in the error message', () => {
    const shortSecret = 'hunter2-super-private';
    const error = catchConfigError(() => loadConfig({ SESSION_SECRET: shortSecret }));
    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).not.toContain(shortSecret);
    expect(JSON.stringify(error.problems)).not.toContain(shortSecret);
  });

  it('never leaks other invalid values either', () => {
    const error = catchConfigError(() =>
      loadConfig({ ...valid, DB_DRIVER: 'leaky-driver', PORT: 'leaky-port' }),
    );
    expect(error.message).toContain('DB_DRIVER');
    expect(error.message).toContain('PORT');
    expect(error.message).not.toContain('leaky');
  });

  it('rejects invalid ports, ws paths and clashing API_PORT', () => {
    expect(() => loadConfig({ ...valid, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...valid, WS_PATH: 'ws' })).toThrow(/WS_PATH/);
    expect(() => loadConfig({ ...valid, API_PORT: '3000' })).toThrow(/API_PORT/);
    expect(() => loadConfig({ ...valid, PORT: '65535' })).toThrow(/API_PORT/);
  });
});

describe('DATABASE_URL', () => {
  const url = 'postgres://user:hunter2-db-password@db.example:5432/drift';

  it('is optional for sqlite and ignored there', () => {
    expect(loadConfig(valid).databaseUrl).toBeUndefined();
    expect(loadConfig({ ...valid, DATABASE_URL: url }).databaseUrl).toBe(url);
  });

  it('is required for postgres, naming the variable', () => {
    const error = catchConfigError(() => loadConfig({ ...valid, DB_DRIVER: 'postgres' }));
    expect(error.message).toContain('DATABASE_URL');
  });

  it('accepts a postgres URL and rejects other schemes without echoing the value', () => {
    expect(loadConfig({ ...valid, DB_DRIVER: 'postgres', DATABASE_URL: url }).dbDriver).toBe(
      'postgres',
    );
    const error = catchConfigError(() =>
      loadConfig({ ...valid, DB_DRIVER: 'postgres', DATABASE_URL: 'mysql://root:hunter2@host/db' }),
    );
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('mysql://');
  });

  it('does not break endpoint config when DB_DRIVER=postgres without a URL', () => {
    expect(loadEndpointConfig({ DB_DRIVER: 'postgres', PORT: '5000' }).port).toBe(5000);
  });
});

describe('loadEndpointConfig', () => {
  it('works without a SESSION_SECRET', () => {
    expect(loadEndpointConfig({ PORT: '5000' })).toEqual({
      host: '127.0.0.1',
      port: 5000,
      apiPort: 5001,
      wsPath: '/ws',
    });
  });
});
