import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/server/app';
import { signToken, hashToken } from '../src/server/auth/token';
import { migrate, initDb } from '../src/server/db/client';

describe('Log Leak Guard', () => {
  let server: any;
  let logs: string[] = [];

  beforeEach(async () => {
    process.env.DB_PATH = '/tmp/test_log_leak.sqlite';
    initDb();
    await migrate();
    logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;

    console.log = (...args) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      originalLog.apply(console, args);
    };
    console.error = (...args) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      originalError.apply(console, args);
    };
    console.warn = (...args) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      originalWarn.apply(console, args);
    };
    console.info = (...args) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      originalInfo.apply(console, args);
    };

    server = createApp();
    await server.ready();

    // Store originals to restore after test
    (global as any)._originalConsole = { originalLog, originalError, originalWarn, originalInfo };
  });

  afterEach(() => {
    const originals = (global as any)._originalConsole;
    if (originals) {
      console.log = originals.originalLog;
      console.error = originals.originalError;
      console.warn = originals.originalWarn;
      console.info = originals.originalInfo;
    }
  });

  // We need to restore console in afterEach
  // But let's just add it to the test for now or use a better structure.

  it('should not leak session secrets or tokens in logs', async () => {
    const callsign = `LEAK-${Math.random().toString(36).substring(2, 10)}`;
    const secret = process.env.SESSION_SECRET || 'dev-secret-key-do-not-use-in-prod';

    // 1. Claim callsign
    const claimResp = await server.inject({
      method: 'POST',
      url: '/api/callsigns',
      payload: { callsign },
    });

    if (claimResp.statusCode !== 200) {
      throw new Error(
        `Claim callsign failed with status ${claimResp.statusCode}: ${claimResp.payload}`,
      );
    }

    const claimData = JSON.parse(claimResp.payload as string);
    const token = claimData.token;
    const tokenHash = hashToken(token);

    // 2. Verify session
    await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: { authorization: `Bearer ${token}` },
    });

    // 3. Logout
    await server.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: { authorization: `Bearer ${token}` },
    });

    const allLogs = logs.join(' ');

    // Assertions: nothing sensitive should appear in logs
    expect(allLogs).not.toContain(secret);
    expect(allLogs).not.toContain(token);
    expect(allLogs).not.toContain(tokenHash);
  });
});
