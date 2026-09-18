# ralph

A long-running agent loop that drives [opencode](https://opencode.ai) through its HTTP API.

Ralph picks the next unfinished task from `.agent/tasks.json`, runs one agent turn against it,
verifies what actually changed in the repository, and repeats until the backlog is done, the
agent needs a human, or progress stops.

## Usage

```bash
npm install && npm run build

node dist/cli.js                     # run the loop in the current directory
node dist/cli.js once                # a single iteration
node dist/cli.js doctor              # check the environment, run nothing
node dist/cli.js config              # print the resolved configuration

node dist/cli.js -C /path/to/project -n 20 -m ollama/qwen3-coder
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every task passes |
| 1 | Iteration budget exhausted with work outstanding |
| 2 | Agent raised `BLOCKED` |
| 3 | Agent raised `DECIDE` |
| 4 | Bad configuration or failed preflight |
| 5 | Model provider or opencode server unusable |
| 6 | Stalled: iterations stopped changing anything |
| 130 | Interrupted |

## Configuration

Resolution order is defaults < `ralph.config.json` < `RALPH_*` environment < CLI flags.

```jsonc
{
  "model": "ollama/qwen3-coder",   // provider/model, as opencode names it
  "maxIterations": 20,
  "pinTask": true,                 // name the task in the prompt instead of letting the model choose
  "timeouts": {
    "iterationMs": 2700000,        // hard ceiling for one turn
    "inactivityMs": 300000         // no events for this long means the agent is wedged
  },
  "retries": {
    "providerRetriesPerIteration": 3,
    "iterationRetries": 1,
    "backoffMs": 15000
  },
  "stall": { "maxUnproductiveIterations": 3 },
  "permissions": {
    "fallback": "allow",           // unattended runs need to proceed without a human
    "deny": ["git push", "git remote"]
  },
  "server": { "url": "http://opencode:4096" }  // attach instead of spawning
}
```

The env overrides worth setting from a k8s manifest: `RALPH_MODEL`, `RALPH_MAX_ITERATIONS`,
`RALPH_SERVER_URL`, `RALPH_SERVER_PASSWORD`, `RALPH_ITERATION_TIMEOUT_MS`,
`RALPH_INACTIVITY_TIMEOUT_MS`, `RALPH_LOG_FORMAT=json`.

## How it works

Ralph spawns `opencode serve` (or attaches to one with `server.url`), then per iteration:

1. Reads `.agent/tasks.json` and picks the first task with `passes: false`.
2. Builds the prompt from `.agent/PROMPT.md`, naming that task.
3. Opens a session, subscribes to `/api/event`, and sends the prompt.
4. Consumes the SSE stream, answering permission requests from policy.
5. Snapshots git and the task list before and after, and compares.

### Why the repository is the source of truth

The agent's `<promise>TASK-7:DONE</promise>` is a claim, not evidence. An iteration counts as
progress only when something actually changed: a commit landed, a `passes` flag flipped, or
files were modified. A run whose iterations stop changing anything ends as `stalled` rather
than quietly burning the whole budget.

### Failure modes it watches for

| Watchdog | What it catches |
| --- | --- |
| `retry-storm` | Provider unreachable or rate limited. opencode retries with backoff, emitting no text and no error — the loop would otherwise hang indefinitely. |
| `inactivity` | Agent produced no events at all for `inactivityMs`. |
| `iteration-timeout` | Turn exceeded its hard budget. |

All three interrupt the session server-side rather than killing a process, so opencode can
clean up. Provider failures and timeouts retry the whole turn (`retries.iterationRetries`);
they say nothing about the task itself.

## Run artefacts

Each run writes to `.agent/history/<runId>/`:

- `iteration-NNN.events.jsonl` — every event received, for debugging
- `iterations.jsonl` — one record per iteration with outcome, usage and repository delta
- `run.json` — the run summary

## Development

```bash
npm test          # unit + integration tests against a fake opencode server
npm run typecheck
```

`test/fixtures/session-events.jsonl` is a real captured session; the event parser is tested
against it so a schema drift in opencode shows up as a test failure rather than a silent
no-op at runtime.
