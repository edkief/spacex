/**
 * TASK-61: `npm run perf:report <desktop|phone>` — the repeatable reference
 * hardware verification. Runs the four committed benchmarks
 * (bench:transitions, bench:render, bench:tick, load:smoke), captures each
 * benchmark's full console report + exit code + wall time, and stores them
 * under .ralph/perf/<device>-<timestamp>/ with a summary.json for the
 * docs/performance.md tables.
 *
 * device:
 *   desktop — runs all four benchmarks on the machine.
 *   phone   — first checks for a reachable phone (adb devices / CDP port);
 *             with no phone connected it writes the BLOCKED-PENDING-DEVICE
 *             marker + the exact commands to run later, and exits 2 (an
 *             honest outcome, never a fabricated pass). With a phone it
 *             runs the same four (Mobile profile is forced in the bench
 *             scripts via PERF_PROFILE=mobile) + the keyboard-only e2e
 *             loop (TASK-54) over the CDP connection.
 *
 * The phone loop needs a real device; the benchmarks themselves are
 * machine-relative proxies (see bench-render.ts header), which is why the
 * report records the device description + git sha alongside every number.
 */
import { spawn, execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..');

const device = process.argv[2];
if (device !== 'desktop' && device !== 'phone') {
  console.error('usage: npm run perf:report <desktop|phone>');
  process.exit(2);
}

/** git sha of the checkout the numbers were measured on. */
function gitSha() {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** CPU/RAM description for the device row of the report table. */
function deviceInfo() {
  const info = { platform: process.platform, arch: process.arch, cpus: 0, ramGb: 0 };
  try {
    const cpu = execFileSync('sh', ['-c', 'lscpu | grep "Model name" | head -1'], {
      encoding: 'utf8',
    });
    info.cpu = cpu.trim().split(':').slice(1).join(':').trim();
  } catch {
    info.cpu = 'unknown';
  }
  try {
    const mem = execFileSync('sh', ['-c', "free -g | awk '/^Mem:/{print $2}'"], {
      encoding: 'utf8',
    });
    info.ramGb = Number(mem.trim() || 0);
  } catch {
    info.ramGb = 0;
  }
  info.cpus = cpus().length;
  return info;
}

function phoneReachable() {
  // 1) ADB: any device in 'device' state.
  try {
    const out = execFileSync('adb', ['devices'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (/\tdevice\s*$/m.test(out)) return 'adb';
  } catch {
    /* adb not installed */
  }
  // 2) Chrome remote debugging on the usual adb-forwarded / manual ports.
  for (const port of [9222]) {
    try {
      const res = fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return `cdp:${port}`;
    } catch {
      /* not reachable */
    }
  }
  return null;
}

const BLOCKED_NOTE = `
BLOCKED-PENDING-DEVICE (phone)
------------------------------
No phone was reachable from this environment (checked: adb device list,
Chrome DevTools Protocol on 127.0.0.1:9222). SC-4 (30 fps mobile floor)
is UNVERIFIED, not passed. To run the phone section later:

  1. Connect the reference phone (mid-range 2023+, 8 GB, mid SoC) and
     enable USB debugging, then:
       adb devices                      # must list the phone
       adb reverse tcp:9222 tcp:9222    # expose the phone's Chrome to the host
     (or run a local Android build of the app, or connect an iPhone over
     USB with Safari Remote Inspection and a CDP bridge such as
     ios-webkit-debug-proxy + openinspector.)
  2. From the phone's Chrome, open http://localhost:3000 with the mobile
     viewport (the Mobile profile is chosen by the client's feature
     detection; force it with ?profile=mobile if available).
  3. Run the suite:
       npm run perf:report phone        # from the app/ directory
     which runs bench:transitions, bench:render (Mobile profile), bench:tick,
     load:smoke + the reduced-FX keyboard-only loop (tests/e2e/
     mobile-profile.spec.ts, Mobile profile forced — TASK-54/59) connected
     over CDP, and records the same .ralph/perf/ artifacts.
  4. The acceptance gates for the phone rows (docs/performance.md):
     render benchmark reduced scene, Mobile profile, no atmosphere dome:
     median frame <= 33 ms (>= 30 fps); keyboard-only loop: no dropped
     frame > 100 ms.
`;

const BENCHES = [
  { key: 'transitions', cmd: 'npm', args: ['run', 'bench:transitions'], note: 'TASK-30' },
  { key: 'render', cmd: 'npm', args: ['run', 'bench:render'], note: 'TASK-58' },
  { key: 'tick', cmd: 'npm', args: ['run', 'bench:tick'], note: 'TASK-60' },
  { key: 'load-smoke', cmd: 'npm', args: ['run', 'load:smoke'], note: 'TASK-18' },
];

function runOne(bench, env) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(bench.cmd, bench.args, {
      cwd: appRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) =>
      resolvePromise({
        ...bench,
        exitCode: code ?? -1,
        wallMs: Date.now() - started,
        output: out,
      }),
    );
    child.on('error', (err) =>
      resolvePromise({
        ...bench,
        exitCode: -1,
        wallMs: Date.now() - started,
        output: `spawn error: ${err.message}\n${out}`,
      }),
    );
  });
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(repoRoot, '.ralph', 'perf', `${device}-${ts}`);
  mkdirSync(outDir, { recursive: true });

  const info = deviceInfo();
  const summary = {
    device,
    deviceTag: device,
    date: new Date().toISOString(),
    gitSha: gitSha(),
    machine: info,
    benches: {},
  };

  if (device === 'phone' && !phoneReachable()) {
    writeFileSync(join(outDir, 'BLOCKED.md'), BLOCKED_NOTE.trim() + '\n');
    writeFileSync(
      join(outDir, 'summary.json'),
      JSON.stringify({ ...summary, blocked: 'PENDING-DEVICE' }, null, 2),
    );
    console.log(BLOCKED_NOTE);
    console.log(`artifacts: ${outDir}`);
    process.exit(2);
  }

  const env = device === 'phone' ? { PERF_PROFILE: 'mobile' } : {};

  for (const bench of BENCHES) {
    console.log(`\n=== [perf:report:${device}] ${bench.note} ${bench.key} ===`);
    const r = await runOne(bench, env);
    writeFileSync(join(outDir, `${bench.key}.txt`), r.output);
    summary.benches[bench.key] = {
      owner: bench.note,
      exitCode: r.exitCode,
      pass: r.exitCode === 0,
      wallMs: r.wallMs,
    };
    console.log(
      `[perf:report] ${bench.key}: exit ${r.exitCode} in ${(r.wallMs / 1000).toFixed(1)} s`,
    );
  }

  // Phone only: the reduced-FX keyboard-only loop with the Mobile profile
  // FORCED (mobile-profile.spec.ts, the TASK-59 e2e that wraps the
  // TASK-54 keyboard loop) over the CDP connection.
  if (device === 'phone') {
    const r = await runOne(
      {
        key: 'keyboard-loop',
        cmd: 'npx',
        args: [
          'playwright',
          'test',
          '--config',
          'playwright.e2e.config.ts',
          'tests/e2e/mobile-profile.spec.ts',
        ],
        note: 'TASK-54/59',
      },
      env,
    );
    writeFileSync(join(outDir, 'keyboard-loop.txt'), r.output);
    summary.benches['keyboard-loop'] = {
      owner: 'TASK-54/59',
      exitCode: r.exitCode,
      pass: r.exitCode === 0,
      wallMs: r.wallMs,
    };
    console.log(
      `[perf:report] keyboard-loop: exit ${r.exitCode} in ${(r.wallMs / 1000).toFixed(1)} s`,
    );
  }

  summary.pass = Object.values(summary.benches).every((b) => b.pass);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(
    `\n[perf:report:${device}] overall: ${summary.pass ? 'PASS' : 'FAIL'} — artifacts in ${outDir}`,
  );
  process.exit(summary.pass ? 0 : 1);
}

main();
