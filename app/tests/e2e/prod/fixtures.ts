/**
 * TASK-77 — Production-path Playwright fixtures.
 *
 * Mirrors `tests/e2e/fixtures.ts` (TASK-70) but instead of spawning
 * the Vite + Fastify dev pair, it boots **the same artefact the
 * Docker image ships**: `node dist-server/index.js`, with
 * `STATIC_DIR=dist/client` so the same server also serves the
 * built client. There is no Vite proxy and no `.env.local`, so
 * `baseURL === apiURL` (single origin) and the operator-only env
 * contract (`SESSION_SECRET`, `GALAXY_SEED`, `DB_DRIVER`,
 * `DB_PATH`, `STATIC_DIR`, `PORT` / `API_PORT`, `PROJECT_ROOT`)
 * is what wires the server together.
 *
 * What this fixture gets right that the dev harness cannot:
 *
 *   - Exercises the esbuild-bundled server (TASK-69), not tsx.
 *   - Hits the production `@fastify/static` client mount, not
 *     Vite's dev server.
 *   - Sets `PROJECT_ROOT` to an empty tmp dir so any leftover
 *     `.env.local` would NOT be loaded — the bundle is configured
 *     by env alone (which is what `app/.dockerignore` does inside
 *     the image: the file is excluded from the build context).
 *
 * Why a worker-scoped fixture (mirroring the dev one)?
 *   - The build (vite + esbuild) takes ~30-60 s. Spinning it up
 *     per test would make the prod gate unusable. The fixture
 *     builds once, writes a stamp file in the worker tmp dir,
 *     and skips the rebuild on subsequent specs that share the
 *     worker. The first spec that lands in this worker pays the
 *     build cost; later ones boot in ~3 s.
 *   - The DB is fresh per worker, so per-spec isolation still
 *     comes from callsigns.
 *
 * Failure mode:
 *   - If the health probe times out, the fixture tears the child
 *     down and throws with the **last 30 captured log lines** so
 *     a CI failure leaves a diagnosable trace.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path of the `app/` directory. */
const APP_ROOT = path.resolve(HERE, "..", "..", "..");
/** Writable dir under app/ where the stamp file lives. */
const WORKER_STATE_DIR = path.join(APP_ROOT, "data", "prod-e2e");

/** 64 hex chars — `assertValidSecret` requires 64+ hex of process entropy. */
function randomSecret(): string {
  let s = "";
  while (s.length < 64) {
    s += Math.floor(Math.random() * 0xffff_ffff).toString(16).padStart(8, "0");
  }
  return s.slice(0, 64);
}

/**
 * Find a random free TCP port on the loopback interface. Same seam as
 * the dev fixture so the prod and dev paths share that helper.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
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

/**
 * Probe a URL until it responds or the timeout elapses. The same
 * 250 ms tick the dev fixture uses, so the failure trace
 * (`last error: ...`) reads the same way across both fixtures.
 */
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

/** Cleanly stop a spawned server, SIGTERM first, then SIGKILL after a grace. */
function killChild(child: ChildProcess): Promise<void> {
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

/**
 * Run `npm run build` + `npm run build:server` once per worker.
 *
 * The stamp file lives in `app/data/prod-e2e/worker-<idx>-stamp.json`
 * and records the SHA-256 of `package.json` + the `git` HEAD mtime
 * so a re-build is triggered when either input changes. A
 * deleted `dist/` is treated as out-of-date (the stamp is
 * removed too if the build dirs are missing on the next boot).
 *
 * Returns the number of milliseconds the build took (0 on a
 * skipped rebuild).
 */
async function ensureBuiltOnce(workerIndex: number): Promise<number> {
  mkdirSync(WORKER_STATE_DIR, { recursive: true });
  const stampPath = path.join(WORKER_STATE_DIR, `worker-${workerIndex}.stamp.json`);
  const distClient = path.join(APP_ROOT, "dist", "client");
  const distServer = path.join(APP_ROOT, "dist-server");
  const packageJson = path.join(APP_ROOT, "package.json");

  // Out-of-date if either build output dir is missing or the
  // stamp doesn't match package.json's hash.
  const built = existsSync(distClient) && existsSync(distServer);
  let stampValid = false;
  if (built && existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as {
        packageJson: string;
      };
      const pkg = readFileSync(packageJson, "utf-8");
      const hash = await sha256Hex(pkg);
      stampValid = stamp.packageJson === hash;
    } catch {
      stampValid = false;
    }
  }
  if (stampValid) return 0;

  const start = Date.now();
  await runNpmScript("build", APP_ROOT);
  await runNpmScript("build:server", APP_ROOT);
  const pkg = readFileSync(packageJson, "utf-8");
  const hash = await sha256Hex(pkg);
  writeFileSync(
    stampPath,
    JSON.stringify({ packageJson: hash, ts: Date.now() }, null, 2),
  );
  return Date.now() - start;
}

/** Quick SHA-256 via `node:crypto` returning lowercase hex. */
async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Spawn `npm run <script>` and stream stdout/stderr; reject on a
 * non-zero exit. Errors at this layer are fatal — the fixture
 * aborts before booting the server so a build failure is loud.
 */
async function runNpmScript(script: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script, "--silent"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = Buffer.concat(chunks).toString().split("\n").slice(-40).join("\n");
      reject(new Error(`npm run ${script} exited with code ${code}\n--- last 40 lines ---\n${tail}`));
    });
  });
}

/** Public fixture shape exposed to spec files. */
export type ProdServer = {
  /** Single origin that serves both the client and the API. */
  baseURL: string;
  /** `baseURL` + `/api` — kept for symmetry with the dev fixture. */
  apiURL: string;
  /** WebSocket URL for `/ws`. */
  wsURL: string;
  /** Absolute path of the per-worker tmp dir holding the SQLite DB. */
  tmpDir: string;
  /** Deterministic galaxy seed used for this worker. */
  galaxySeed: string;
  /** Wall-clock ms the prod build took (0 on a cached rebuild). */
  buildMs: number;
};

export const test = base.extend<{ prodServer: ProdServer }, { workerServer: ProdServer }>({
  workerServer: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture arg to be the destructured bag even when unused.
    async ({}, use, workerInfo) => {
      // Build first. The first spec file in this worker pays the
      // build cost; later ones skip via the stamp file.
      const buildMs = await ensureBuiltOnce(workerInfo.workerIndex);
      const apiPort = await findFreePort();
      // An empty per-worker tmp dir — also the empty PROJECT_ROOT
      // the spec demands (no `.env.local` is reachable here,
      // mirroring the image's `.dockerignore`).
      const tmpDir = mkdtempSync(path.join(tmpdir(), "drift-prod-"));
      const galaxySeed = `PROD-E2E-${workerInfo.workerIndex}-${Date.now().toString(36)}`;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(apiPort),
        API_PORT: String(apiPort),
        // The image serves the built client from `/app/dist/client`.
        STATIC_DIR: path.join(APP_ROOT, "dist", "client"),
        DB_DRIVER: "sqlite",
        DB_PATH: path.join(tmpDir, "drift.db"),
        GALAXY_SEED: galaxySeed,
        SESSION_SECRET: randomSecret(),
        // Empty dir = no `.env.local` discoverable, mirroring the
        // image's `.dockerignore` (which excludes `.env.local`).
        PROJECT_ROOT: tmpDir,
        LOG_LEVEL: "warn",
        CI: "1",
      };

      const child = spawn(process.execPath, ["dist-server/index.js"], {
        cwd: APP_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      const logs: string[] = [];
      child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
      child.on("error", (err) => logs.push(`[spawn-error] ${err.message}`));

      const healthUrl = `http://localhost:${apiPort}/api/health`;
      try {
        await waitForHealth(healthUrl, 60_000);
      } catch (err) {
        await killChild(child);
        rmSync(tmpDir, { recursive: true, force: true });
        const tail = logs.slice(-30).join("");
        throw new Error(
          `drift prod e2e fixture: prod server failed to become healthy.\n${String(err)}\n--- last logs ---\n${tail}`,
          { cause: err },
        );
      }

      const server: ProdServer = {
        baseURL: `http://localhost:${apiPort}`,
        apiURL: `http://localhost:${apiPort}`,
        wsURL: `ws://localhost:${apiPort}/ws`,
        tmpDir,
        galaxySeed,
        buildMs,
      };
      try {
        await use(server);
      } finally {
        await killChild(child);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],

  prodServer: async ({ workerServer }, use) => {
    await use(workerServer);
  },
});

export { expect };

/**
 * Same shared canvas-readback seam as the dev fixture. The
 * production renderer opts into `preserveDrawingBuffer: true`
 * for the same reason the dev renderer does, so a 2-D
 * `drawImage` + `getImageData` round trip returns real pixels.
 */
export async function sampleCanvasPixels(
  page: Page,
  size = 256,
): Promise<{
  width: number;
  height: number;
  pixels: Uint8Array;
  variance: number;
  starFraction: number;
}> {
  return page.evaluate((s) => {
    return new Promise<{
      width: number;
      height: number;
      pixels: Uint8Array;
      variance: number;
      starFraction: number;
    }>((resolve, reject) => {
      const source = document.getElementById("drift-canvas") as HTMLCanvasElement | null;
      if (!source) {
        reject(new Error("missing #drift-canvas"));
        return;
      }
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
      const sx = Math.max(0, Math.floor((source.width - w) / 2));
      const sy = Math.max(0, Math.floor((source.height - h) / 2));
      ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
      const image = ctx.getImageData(0, 0, w, h);
      const pixels = new Uint8Array(image.data.buffer);
      let sum = 0;
      let sumSq = 0;
      let starCount = 0;
      const n = pixels.length / 4;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        sum += luma;
        sumSq += luma * luma;
        if (luma > 30) starCount++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      resolve({
        width: w,
        height: h,
        pixels,
        variance,
        starFraction: starCount / n,
      });
    });
  }, size);
}
