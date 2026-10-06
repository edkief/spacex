# Contributing

How work is tracked, gated, and reviewed in this repo. The project is built by a
Ralph automation loop; humans (or the escalation agent in their place) make the
decisions it records.

## The Ralph task workflow

Work is a list of tasks in [.ralph/tasks.json](../../.ralph/tasks.json), one JSON
spec per task in [.ralph/tasks/](../../.ralph/tasks/). Each task has steps, an
`acceptanceCriteria` list, and a `passes` flag.

- **One task per invocation.** An iteration picks exactly one task with
  `passes: false`, implements its steps step by step, and commits — then stops.
  Never batch multiple tasks in one run.
- **Check steering first.** Before starting task work, read
  [.ralph/STEERING.md](../../.ralph/STEERING.md) — it holds critical work that
  must be cleared in sequence. Only proceed to tasks when it is clear.
- **The `passes:false` convention.** A task is only closed by setting its
  `passes` to `true` in `.ralph/tasks.json` **after** every acceptance criterion
  is met and the gates below are green. Until then it stays `false`.
- **Log + structure.** Each closed task adds a newest-at-top entry to
  [.ralph/logs/LOG.md](../../.ralph/logs/LOG.md) (date, summary, screenshot path)
  and updates [.ralph/STRUCTURE.md](../../.ralph/STRUCTURE.md) if directories
  changed (dotfiles, tests, and config are excluded).
- **Handoffs.** A run that runs out of time writes a handoff to
  `.ralph/handoff/TASK-<id>.md` (what landed, what remains, exact next steps) so
  the next iteration continues rather than restarts.

## Test gates

Run these from `app/` before merging. "If you didn't test it, it doesn't work."

| gate               | command              | what it covers                                                                               |
| ------------------ | -------------------- | -------------------------------------------------------------------------------------------- |
| Unit + integration | `npm test`           | Vitest: physics, galaxy determinism, shard sim, protocol, repo, client stores                |
| Types              | `npm run typecheck`  | `tsc --noEmit` across the monorepo                                                           |
| Lint + format      | `npm run lint`       | `eslint .` + `prettier --check .` (or `eslint --fix` + `prettier --write`)                   |
| E2E                | `npm run test:e2e`   | Playwright, headless chromium; boots an isolated server (`npm run dev:test`) on random ports |
| Load smoke         | `npm run load:smoke` | 16-client, 30 s: snapshot rate ≥ 9.5 Hz + the 17th-connection cap probe                      |

**Extra rule for combat / economy changes:** run `npm run load:smoke` before
merging. Those systems are the ones the 16-player load gate protects, and a
regression that only shows up under load is the class of bug it exists to catch.

For UI work, do a Playwright smoke (console clean + a minimal happy-path e2e) and
save a screenshot to `.ralph/screenshots/TASK-<id>-<n>.png`.

## Perf and wire contract

Performance is gated by four committed benchmarks, each owned by a task. They are
run together by `npm run perf:report <desktop|phone>` and reported in
[performance.md](performance.md):

| benchmark   | command                     | owner   | gate                                                                      |
| ----------- | --------------------------- | ------- | ------------------------------------------------------------------------- |
| transitions | `npm run bench:transitions` | TASK-30 | every transition phase p99 < 4 ms over baseline, no frame > 100 ms        |
| render      | `npm run bench:render`      | TASK-58 | 60 fps (p95 ≤ 20 ms), zero frames > 50 ms, draw/material/triangle budgets |
| server tick | `npm run bench:tick`        | TASK-60 | p50 < 15 ms, p95 < 30 ms, ≥ 15 Hz at the 16-player worst case             |
| load smoke  | `npm run load:smoke`        | TASK-18 | ≥ 9.5 Hz snapshots for 16 clients, 17th rejected                          |

**"Fix it in the same PR."** The perf numbers are the contract: if a change
regresses an owned benchmark, the fix ships in the same PR (or re-opens the
owning task with a handoff) — you do not land a known red gate. A failing
benchmark is never "reported as passed"; it is measured and routed to its owner.

**Schema change → protocol doc in the same PR.** The WS wire contract and the
REST API are documented from the zod schemas in
[schemas.ts](../src/shared/protocol/schemas.ts) (see [protocol.md](protocol.md)).
If you add, remove, or change a message type, a payload field, or a REST endpoint,
update `protocol.md` in the same PR. If you add an env variable, add it to
[ops.md](ops.md) in the same PR. A doc with a command that doesn't run is a bug.

## Code-quality bar

From [AGENTS.md](../../AGENTS.md):

- **Reuse before creating.** Search first, extend if 80% there, extract if you'd
  copy-paste.
- **File size: 200–300 lines max.** Split by responsibility, extract
  sub-components, separate logic from presentation, group by feature.
- **One task per invocation** (see the workflow above).
- **Code style:** clear code, inline comments sparingly, block-comment methods at
  the top, Conventional Commit format for every commit.
- **Test to verify:** unit tests, e2e, type errors, lint errors, Playwright smoke,
  and a screenshot that the UI is as expected.

Commit messages follow Conventional Commits (`feat:`, `fix:`, `perf:`, `test:`,
`docs:`, `chore:`, `refactor:`) and reference the task, e.g.
`perf(TASK-61): reference-hardware verification complete`.
