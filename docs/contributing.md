# Contributing to Drift

Drift is built by an agent loop (Ralph) against a PRD, with a human in the
loop for decisions. This page is the contract for changing the code, the tests
and the docs.

The engineering standards live in [`AGENTS.md`](../AGENTS.md) — this document is
the _workflow_ around them.

- [1. The task workflow](#1-the-task-workflow)
- [2. Test gates](#2-test-gates)
- [3. The performance contract](#3-the-performance-contract)
- [4. Code-quality bar](#4-code-quality-bar)
- [5. Protocol changes](#5-protocol-changes)
- [6. Docs accuracy](#6-docs-accuracy)

---

## 1. The task workflow

Work is a flat list in [`.ralph/tasks.json`](../.ralph/tasks.json):

```json
{
  "id": "TASK-69",
  "title": "Documentation: README, architecture, protocol, ops, contribution",
  "category": "documentation",
  "specFilePath": ".ralph/tasks/TASK-69.json",
  "passes": false
}
```

Rules that the loop (and any agent picking up a task) must follow:

1. **Check `.ralph/STEERING.md` first.** If it contains critical work
   (environment broken, dependencies missing, no dev server), do that before
   any feature work. It is cleared only when there is nothing critical left.
2. **Pick exactly one task** — the highest-priority one with `passes: false`.
   **One task per invocation.** Never batch two tasks into one commit, never
   "start" another task while the current one is in flight.
3. **Read the full spec** at `.ralph/tasks/TASK-<id>.json` before writing code.
   It carries `acceptanceCriteria`, ordered `steps` and `technicalNotes`. The
   acceptance criteria are the contract; the steps are the suggested order.
   `dependencies` lists the tasks that must already be `passes: true`.
4. **Decided questions are settled.** `.ralph/decisions.jsonl` records the
   answers a human (or the escalation agent) has already given, newest last.
   Follow them over the spec text where the two disagree, and do not re-ask.
5. **Write the test with the change.** A behaviour change without a test that
   fails before it and passes after is not done.
6. **UI tasks additionally need a smoke test**: run the dev server, open the
   page in Playwright, check the console for errors, add a minimal happy-path
   e2e spec, and save a screenshot under `.ralph/screenshots/TASK-<id>-<n>.png`.
7. **Green before done.** `eslint --fix`, `prettier --write`, `tsc --noEmit`, and
   the full test suite. A pre-existing test you broke is your problem.
8. **Flip `passes: true`** only when the acceptance criteria are met, then write
   the log entry.
9. **Log entry** in [`.ralph/logs/LOG.md`](../.ralph/logs/LOG.md) — newest at
   the top, one `### <date> — Iteration N (TASK-<id>) — <headline>` section:
   what was built, what was measured, what the tests prove, which files were
   added/modified, and honestly-flagged gaps. Screenshots referenced by path.
10. **Update [`.ralph/STRUCTURE.md`](../.ralph/STRUCTURE.md)** if the directory
    layout changed (dotfiles, tests and build output excluded).
11. **Commit** with a Conventional Commit message that names the task:

    ```
    docs(TASK-69): README, architecture, protocol, ops and contribution docs
    perf(TASK-30): best-of-N frame sampling closes the repeatability gate
    fix(server): count real players, not AI ghosts, against the shard cap
    ```

12. **Stop.** Output the completion marker and end the turn. Never `git push`
    from inside a task invocation, and never edit git remotes.

If a task is genuinely impossible in the environment (no device, no network, no
credentials), report it as `BLOCKED` with the reason instead of faking a pass.

---

## 2. Test gates

Run from `app/`. A change is mergeable when these are green:

| Gate                 | Command                                                   | When it is mandatory                                                                                                                                                     |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit + integration   | `npm test`                                                | **Always.** Full Vitest suite (determinism, protocol, sim, combat, economy, abuse, audits).                                                                              |
| Types                | `npm run typecheck`                                       | **Always.**                                                                                                                                                              |
| Lint + format        | `npm run lint` (`lint:fix` to fix)                        | **Always.**                                                                                                                                                              |
| End to end           | `npm run test:e2e`                                        | Any client-visible or WS-visible change. The Playwright fixture boots its own dev server per worker with a temp SQLite DB and a random port — no external server needed. |
| Load smoke           | `npm run load:smoke`                                      | Any change to combat, economy, persistence, the shard router or the broadcast path. 16 clients / 30 s, writes `data/load-report.json`, exits non-zero if a gate fails.   |
| Full load acceptance | `npm run load` (5 min)                                    | Release candidates, and anything touching shard lifecycle.                                                                                                               |
| Benchmarks           | `npm run bench:transitions`, `bench:render`, `bench:tick` | See the performance contract below.                                                                                                                                      |
| Perf report          | `npm run perf:report desktop`                             | Before a sign-off or a release; see [performance.md](performance.md).                                                                                                    |

Cheat-resistance changes must also keep `tests/abuse/` green: the audit test
asserts that **every message type has a zod schema and a rate limiter**, so
adding a stateful verb without both fails immediately.

---

## 3. The performance contract

Performance is a gate, not a wish. Each benchmark has an **owning module**, and
the budget lives next to the code that enforces it — never duplicated into a
test or a doc:

| Benchmark          | Command                              | Budgets owned by                                                                                                                                                                        | Gates                                                                                                                                                   |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regime transitions | `npm run bench:transitions`          | [`src/client/test/transitionCycle.constants.ts`](../app/src/client/test/transitionCycle.constants.ts) (`TRANSITION_BUDGET_MS`, `NO_PULL_THRESHOLD_MS`) + `FrameScheduler` budget checks | per-frame transition delta < 4 ms at p99; no frame > 100 ms; repeatability variance < 20 %                                                              |
| Render budget      | `npm run bench:render`               | [`src/shared/perf.ts`](../app/src/shared/perf.ts) (`PERF_PROFILES`, `budgets`)                                                                                                          | p95 frame within budget, draw calls < 120, triangles < 500 k, materials < 40, no > 50 ms spikes, ≥ 30 % improvement over the untuned baseline           |
| Server tick        | `npm run bench:tick`                 | `TICK_BUDGETS` in the tick benchmark                                                                                                                                                    | p95 tick < 30 ms, effective rate ≥ 15 Hz, heap growth < 30 MB                                                                                           |
| Load / stability   | `npm run load`, `npm run load:smoke` | `LOAD_BUDGETS` in the load harness                                                                                                                                                      | snapshot rate ≥ 9.5 Hz, frame p95 < 16 KiB, input→ack RTT p95 < 100 ms, exact 16-player cap, consistent entity list after reconnects, no spurious kicks |

Rules:

- **A benchmark failure is a blocker for the change that caused it.** Fix it in
  the same PR or do not merge the change. There is no "known flake" bucket:
  if a gate is measuring host noise rather than the code, fix the _measurement_
  (TASK-30 did exactly that — best-of-N frame sampling plus a p95-based
  repeatability statistic) rather than loosening the budget.
- **A failing benchmark re-opens its owning task**, it does not create a new
  one. The perf report maps every red row to the task that owns it.
- **Budgets have exactly one home.** If you change one, the report
  (`scripts/perf-report/collect.ts`) reads the same constant, so the tables
  cannot drift.
- **Never claim a number you did not measure.** Record the git sha, the device,
  and the exact command with the numbers you quote.

---

## 4. Code-quality bar

From [`AGENTS.md`](../AGENTS.md), enforced in review:

- **Reuse before creating.** Search first; extend what is 80 % of the need;
  extract a shared module instead of copy-pasting.
- **200–300 lines per file.** Bigger means split by responsibility: extract
  sub-components, move logic into hooks/utils, group by feature rather than by
  type. A "utils" file that accumulates unrelated exports is a smell.
- **Clear code, sparse comments.** Comments explain _why_, not _what_. Methods
  get a block comment at the top describing what they do and any non-obvious
  contract.
- **Determinism is non-negotiable.** No `Math.random`, no `Date.now()` and no
  ambient time in a generation path; seed in, value out. Time is injected as a
  `now` parameter so tests stay deterministic.
- **Server authority.** The client predicts; the server decides. A client-side
  mutation that the server does not confirm must be visibly corrected.
- **Validate at the boundary.** Every WS payload and REST body goes through a
  zod schema; the repository re-validates what it persists.
- **Conventional Commits**, task id in the message.

---

## 5. Protocol changes

`app/src/shared/protocol/schemas.ts` is the single source of truth for every
message type. Adding a type is two steps in the code and one in the docs:

1. add the zod schema,
2. register it in `PAYLOAD_SCHEMAS`,
3. **update [`docs/protocol.md`](protocol.md) in the same PR** — the message
   table, any new error code in `ErrorCodeSchema`, and any new rate limit.

The compiler will refuse a message type that is not registered, but nothing
refuses a stale doc. When reviewing a protocol PR, check the doc diff: every
added `type:` key in `PAYLOAD_SCHEMAS` must appear in the protocol table, and
every `ErrorCodeSchema` value must appear in the error-code table. (There are
46 message types and 21 error codes at the time of writing.)

Bumping `PROTOCOL_VERSION` is a breaking change: it makes every mismatched peer
refuse the connection with `version-mismatch` / close `1002`, so it needs a
migration note in the PR and a line in the protocol doc.

---

## 6. Docs accuracy

The documentation set is [`README.md`](../README.md),
[architecture.md](architecture.md), [protocol.md](protocol.md),
[ops.md](ops.md), [contributing.md](contributing.md) and
[performance.md](performance.md).

**A command in a doc that does not run is a bug.** When you touch behaviour that
a doc describes:

- re-run every command in the affected section (the quick start, the backup
  procedure, the benchmark commands),
- check every file path the doc links actually exists,
- cross-check env vars against the code (`grep -rhoE "process\.env\.[A-Z_0-9]+"
src scripts tests | sort -u`) — an env var that is documented but unread, or
  read but undocumented, is a defect in one of the two,
- update the numbers from the run you actually did, and keep "known gaps" honest:
  if something is unverified, say unverified rather than rounding it up to a
  pass.
