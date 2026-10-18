/**
 * TASK-70 — Playwright e2e harness fixtures.
 *
 * Bootstraps a self-contained dev server (Vite + Fastify/ws) per
 * test worker so every spec file runs against a clean SQLite DB
 * in a tmp directory and a random free port pair. The fixture
 * tears the child process down on test-file completion, so two
 * fixtures don't trample each other when the suite runs in
 * parallel or when the developer re-runs a single spec.
 *
 * Why a worker-scoped fixture (not test-scoped)?
 *   - The dev server's boot takes ~6 s; spinning one up per test
 *     would make the harness unusable. Boot once per worker (=
 *     per test file in the default Playwright config).
 *   - The DB is fresh per worker too, so per-test isolation comes
 *     from distinct callsigns rather than shared state.
 *
 * Why env-overrides rather than config files?
 *   - The Drift server already reads `PORT`, `API_PORT`, and
 *     `DB_PATH` from the environment. Setting those env vars is
 *     less invasive than a dedicated test config and keeps the
 *     test harness aligned with how the server actually parses
 *     configuration.
 *
 * The exported `test` is a Playwright `test` extension that
 * hides the `serverProcess`/`baseURL`/`wsURL`/`apiURL` fixtures
 * from the consumer — consumers only see the convenient types.
 */
import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Absolute path of the `app/` directory — the fixture spawns
 * `npm run dev` from there so the workspace's npm scripts
 * resolve correctly. Playwright's `testDir` is `./tests`, so
 * `${HERE}/../..` resolves to `app/`.
 */
const APP_ROOT = path.resolve(HERE, "..", "..");

/**
 * Find a random free TCP port on the loopback interface. Resolves
 * the port before closing the listener so the gap between "find"
 * and "use" is small (kernel port-reuse is bounded by TIME_WAIT,
 * which only matters for the same source-port + same peer combo).
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    // Bind to `::1` (IPv6 loopback) so the Vite dev server's
    // own `localhost` listener (which on this system resolves
    // to `::1`) can share the port. Binding to `127.0.0.1`
    // works for Fastify (which listens on `0.0.0.0`) but not
    // for Vite (which by default binds only to localhost).
    srv.listen(0, "::1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Probe a URL until it responds or the timeout elapses. */
async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForHealth(${url}) timed out after ${timeoutMs} ms; last error: ${String(lastErr)}`,
  );
}

/** Cleanly stop a spawned dev server, SIGTERM first, then SIGKILL after a grace. */
function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const escalate = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 5_000);
    escalate.unref?.();
    child.once("exit", () => {
      clearTimeout(escalate);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  });
}

/** Public fixture shape exposed to spec files. */
export type DriftServer = {
  /** Base URL the browser should use (Vite dev server). */
  baseURL: string;
  /** Direct URL to the Fastify server (bypasses the Vite proxy). */
  apiURL: string;
  /** WebSocket URL for `/ws`. */
  wsURL: string;
  /** Absolute path of the per-worker tmp dir holding the SQLite DB. */
  tmpDir: string;
  /** Deterministic galaxy seed used for this worker. */
  galaxySeed: string;
};

/**
 * Custom Playwright test with a worker-scoped `driftServer`
 * fixture. The fixture spawns `npm run dev` with env overrides,
 * waits for `/api/health`, and tears the process down on worker
 * completion.
 *
 * Per-step acceptance:
 *   - Boots the dev server (app + API/WS on a random free port)
 *   - SQLite DB in a tmp dir via env override
 *   - Tears it down after the test file
 *   - Global timeout 60 s (configured in playwright.config.ts)
 */
export const test = base.extend<{ driftServer: DriftServer }, { workerServer: DriftServer }>({
  // Worker-scoped: one server per test file.
  workerServer: [
    async ({}, use, workerInfo) => {
      // Allocate two free ports: one for Vite (the browser-facing
      // dev server) and one for the Fastify + ws backend.
      const vitePort = await findFreePort();
      const apiPort = await findFreePort();
      const tmpDir = mkdtempSync(path.join(tmpdir(), "drift-e2e-"));
      // Distinct seed per worker so the dev DB never collides
      // even when two workers boot in parallel.
      const galaxySeed = `E2E-${workerInfo.workerIndex}-${Date.now().toString(36)}`;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Override the dev server's port pair.
        PORT: String(vitePort),
        API_PORT: String(apiPort),
        // Fresh SQLite DB in the per-worker tmp dir.
        DB_DRIVER: "sqlite",
        DB_PATH: path.join(tmpDir, "drift.db"),
        // Deterministic galaxy + a stable session secret so the
        // signed token codec produces consistent outputs.
        GALAXY_SEED: galaxySeed,
        SESSION_SECRET:
          process.env.SESSION_SECRET ||
          "23b53d2c2b60c049a9b19c981de9fbaf6611a641769fb273bd94ea7131a77cb7",
        // Quiet the dev server logs a bit so the test output stays
        // readable; the harness still surfaces errors via the
        // captured streams.
        LOG_LEVEL: "warn",
        // Disable the keepalive watchdog during tests so the
        // server can shut down cleanly when the worker ends.
        CI: "1",
      };

      const child = spawn("npm", ["run", "dev", "--silent"], {
        cwd: APP_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      // Drain stdout/stderr into a buffer so a failure mode is
      // diagnosable from the test report (Playwright attaches
      // captured output to the failure message).
      const logs: string[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        logs.push(chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logs.push(chunk.toString());
      });
      child.on("error", (err) => {
        // Surface spawn errors via the logs buffer so a teardown
        // assertion can find them.
        logs.push(`[spawn-error] ${err.message}`);
      });

      const healthUrl = `http://localhost:${apiPort}/api/health`;
      try {
        await waitForHealth(healthUrl, 45_000);
      } catch (err) {
        await killChild(child);
        rmSync(tmpDir, { recursive: true, force: true });
        const tail = logs.slice(-30).join("");
        throw new Error(
          `drift e2e fixture: dev server failed to become healthy.\n${String(err)}\n--- last logs ---\n${tail}`,
        );
      }

      const server: DriftServer = {
        baseURL: `http://localhost:${vitePort}`,
        apiURL: `http://localhost:${apiPort}`,
        wsURL: `ws://localhost:${apiPort}/ws`,
        tmpDir,
        galaxySeed,
      };
      try {
        await use(server);
      } finally {
        await killChild(child);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],

  // Test-scoped view of the worker fixture so each test sees a
  // typed `server` (and the `baseURL` is wired into `page.goto`).
  driftServer: async ({ workerServer }, use) => {
    await use(workerServer);
  },
});

/** Re-export `expect` for spec convenience. */
export { expect };

/**
 * Sample a small region of the live WebGL canvas by compositing
 * it into a 2D context and reading back via `getImageData`.
 *
 * Why not `readPixels` directly?
 *   - `gl.readPixels` reads from the **current** draw buffer. By
 *     the time the test's evaluate() runs, the browser has likely
 *     swapped the buffer to the display, leaving the read buffer
 *     empty. Compositing into a 2D canvas pulls the current
 *     frame (the one on screen) into a 2D image we can sample
 *     deterministically.
 *
 * Returns the RGBA pixel buffer + variance of the luminance
 * channel. A non-uniform image (a real starfield) has variance
 * > 0; a flat-black fallback has variance === 0.
 */
export async function sampleCanvasPixels(
  page: import("@playwright/test").Page,
  size: number,
): Promise<{ width: number; height: number; pixels: Uint8Array; variance: number }> {
  return page.evaluate((s) => {
    return new Promise<{ width: number; height: number; pixels: Uint8Array; variance: number }>(
      (resolve, reject) => {
        const source = document.getElementById("drift-canvas") as HTMLCanvasElement | null;
        if (!source) {
          reject(new Error("missing #drift-canvas"));
          return;
        }
        // The WebGL canvas needs `preserveDrawingBuffer: true`
        // to be drawn into a 2D canvas (the default is to clear
        // after the swap). Our starfield opts in to that flag.
        // Some browsers still snapshot from the swap chain in
        // odd states; if the sample comes back black we fall
        // back to `requestAnimationFrame` then a second draw.
        const w = Math.max(1, Math.floor(s));
        const h = w;
        const scratch = document.createElement("canvas");
        scratch.width = w;
        scratch.height = h;
        const ctx = scratch.getContext("2d");
        if (!ctx) {
          reject(new Error("2D context unavailable"));
          return;
        }
        // Centre the readback on the live canvas — grab a
        // `w × h` patch from the middle.
        const sx = Math.max(0, Math.floor((source.width - w) / 2));
        const sy = Math.max(0, Math.floor((source.height - h) / 2));
        ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
        const image = ctx.getImageData(0, 0, w, h);
        const pixels = new Uint8Array(image.data.buffer);
        let sum = 0;
        let sumSq = 0;
        const n = pixels.length / 4;
        for (let i = 0; i < pixels.length; i += 4) {
          // ITU-R BT.601 luminance.
          const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          sum += luma;
          sumSq += luma * luma;
        }
        const mean = sum / n;
        const variance = sumSq / n - mean * mean;
        resolve({ width: w, height: h, pixels, variance });
      },
    );
  }, size);
}