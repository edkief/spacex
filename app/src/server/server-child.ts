import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocket } from 'ws';

/**
 * Integration-test helper (extracted from the TASK-24 crash-restart test):
 * boots the REAL server (src/server/index.ts) as a child process on a
 * chosen port with tsx's loader flags, and provides a minimal WS protocol
 * client. Shared by the TASK-24 crash-restart and TASK-12 shutdown tests.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Child {
  child: ChildProcess;
  base: number;
  /** Recent server output, attached to assertion errors for debugging. */
  tail(): string;
}

export interface BootServerOptions {
  base: number;
  dbPath: string;
  galaxySeed: string;
  /** Same secret across BOTH boots in a restart test: the token must survive. */
  sessionSecret?: string;
  /** The 30 s default flush cadence; shorten it so short flights get flushed. */
  flushIntervalMs?: number;
}

export function bootServer(opts: BootServerOptions): Child {
  const env = {
    ...process.env,
    PORT: String(opts.base),
    SESSION_SECRET: opts.sessionSecret ?? 'server-child-test-secret',
    GALAXY_SEED: opts.galaxySeed,
    DB_DRIVER: 'sqlite',
    DB_PATH: opts.dbPath,
    DATABASE_URL: '',
    SYSTEM_INSTANCE_COUNT: '1',
    SHARD_FLUSH_INTERVAL_MS: String(opts.flushIntervalMs ?? 300),
  };
  // Invoke tsx's loader flags directly (same command line the tsx CLI
  // builds) so the spawned PID is the script's own node process — any
  // intermediate wrapper would make child.kill() orphan the real process.
  const tsxDist = path.join(appDir, 'node_modules', 'tsx', 'dist');
  const child = spawn(
    process.execPath,
    [
      '--require',
      path.join(tsxDist, 'preflight.cjs'),
      '--import',
      pathToFileURL(path.join(tsxDist, 'loader.mjs')).href,
      path.join(appDir, 'src', 'server', 'index.ts'),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));
  return {
    child,
    base: opts.base,
    tail: () => out.slice(-4000),
  };
}

/** Poll /api/health until the server answers 200 (real boot, real listen). */
export async function waitReady(c: Child, timeoutMs = 45000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (c.child.exitCode !== null) {
      throw new Error(`server exited with code ${c.child.exitCode}:\n${c.tail()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${c.base}/api/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`server did not become ready in ${timeoutMs} ms:\n${c.tail()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal WS protocol client (hello → auth → join_system, message queue). */
export class WsChildClient {
  private ws: WebSocket;
  private queue: any[] = [];
  private waiters: Array<{
    predicate: (m: any) => boolean;
    resolve: (m: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  closed = false;

  constructor(base: number, token: string, systemId: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${base}/ws`);
    this.ws.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      this.queue.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.predicate(m)) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(m);
        }
      }
    });
    this.ws.on('close', () => (this.closed = true));
    this.ws.on('open', () => {
      this.send({ v: 1, type: 'hello', payload: { v: 1 } });
      this.send({ v: 1, type: 'auth', payload: { token } });
      this.send({ v: 1, type: 'join_system', payload: { systemId } });
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next(predicate: (m: any) => boolean, what: string, timeoutMs = 8000): Promise<any> {
    const found = this.queue.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      this.waiters.push({
        predicate: (m) => {
          if (!predicate(m)) return false;
          // drop it from the queue so later next() calls don't reuse it
          const i = this.queue.indexOf(m);
          if (i >= 0) this.queue.splice(i, 1);
          return true;
        },
        resolve,
        reject,
        timer,
      });
    });
  }

  /** The latest entity_update payload's entity for id (recomputed each call). */
  latestEntity(id: string): any | undefined {
    let out: any;
    for (const m of this.queue) {
      if (m.type !== 'entity_update') continue;
      const e = m.payload.entities.find((x: any) => x.id === id);
      if (e) out = { ...e, at: Date.now() };
    }
    return out;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}
