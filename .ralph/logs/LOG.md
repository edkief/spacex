2026-10-24 20:00: Completed TASK-20: Ship acquisition. Implemented starter ship ('scout') on claim, ship purchase endpoint with atomic credit withdrawal and ship swapping, and current ship retrieval with merged class stats. Added comprehensive integration tests and wired in-process event bus for shard notification. Verified with vitest.

2026-10-24: TASK-22 implemented: deterministic flight model (space, atmosphere, VTOL) with ground collision and golden trajectory fixtures. All unit tests passed.

2026-10-24 19:15: Completed TASK-41: Implemented atomic credits balance with persistence. Updated `withdrawCredits` to use atomic UPDATE for race-condition prevention. Implemented `GET /api/players/me` endpoint with a new `authMiddleware`. Added comprehensive atomicity and concurrency tests (100 simultaneous withdrawals) verifying balance integrity. Verified with full test suite and typecheck.
\n
2026-10-24: Defined 3 data-driven ship classes (scout, freighter, interceptor) in app/src/shared/ships.ts with balance invariants and helper functions. Added unit tests.
2026-10-24 18:50: Completed TASK-66: Session token integrity. Implemented POST /api/session/logout and WS 'logout' message for session revocation. Added exhaustive unit tests for token signing, expiry, and tampering. Added log-leak guard integration test to ensure session secrets and tokens are not logged. Verified with full test suite.

2026-10-24 18:40: Completed TASK-10: Callsign-only auth with signed session tokens. Implemented HMAC-signed session tokens, callsign claim endpoint (/api/callsigns), and session verification (/api/session and WS handshake). Verified with integration tests.
\n
2026-10-24 17:59: Completed TASK-65: Per-connection rate limiting and chat spam control. Implemented TokenBucket and ChatLimiter, integrated into WS handler with escalation (drop on 3 violations). Verified with unit and integration tests, including a flood benchmark ensuring p95 tick < 30ms.
2026-10-24 17:55: Completed TASK-65. Implemented per-connection rate limiting using a Token Bucket (20 msg/s, 40 burst) and a Chat Limiter (1 msg/2s, 10/30s window, 280 chars). Added escalation logic that drops connections with code 4009 after 3 violations within 10s. Verified with unit and integration tests.
2026-10-24 17:40: Completed TASK-64. Updated `decodeEnvelope` and `parseMessage` to use `zod.safeParse` for zero-throw control flow. Hardened WebSocket dispatcher to handle validation results without crashing. Updated integration and fuzz tests to support new result-based decoding. Verified with full test suite and typecheck.
2026-10-24 17:28: Completed TASK-64. Hardened input validation for all inbound messages using strict Zod schemas. Implemented a 64KB message size limit on the WebSocket layer and increased the unknown-message disconnect threshold to 50. Added a comprehensive fuzz test suite verifying rejection of malformed payloads (NaN, Infinity, deep nesting, over-sized strings, unknown fields) without server crashes. Verified with typecheck, lint, and integration tests.
2026-10-24: Completed TASK-9. Implemented WebSocket protocol with typed versioned envelopes, Zod schemas, and a robust handshake flow (hello -> auth -> join_system). Added keepalive ping/pong and unknown-type handling. Verified with unit and integration tests.
2026-10-24: Completed TASK-63 - Persistence service with save points and crash recovery.
- Implemented unit tests for `PersistService` verifying save/load logic, dirty tracking, and save point triggers.
- Implemented crash recovery test using a child process and SIGKILL, verifying state restoration from SQLite.
- Implemented performance benchmark for dirty ship saves (16 ships < 20ms).
- Note: Save point wiring depends on shard/sim code which appears to be missing from current workspace, but hooks are fully implemented and verified via unit tests.

2026-10-24 15:30 - Completed TASK-5: Implemented deterministic surface chunk generator with value-noise + fBm, boundary continuity, and seeded node/pad placement. Verified with determinism and golden snapshot tests.
2026-10-24 15:08 - Completed TASK-3: Implemented deterministic star generator with seeded galaxy layout, spectral weighting, and unique name generation. Added golden snapshot fixture.
2026-10-24 15:03 - Completed TASK-2: Implemented deterministic PRNG (xoshiro128**) and FNV-1a hashing. Verified with golden values, distribution tests, and Node/Browser parity.

# Project Logs

2026-10-24: Completed TASK-68. Scaffolded TS monorepo in `app/` with Vite client, Fastify server, and shared source tree. Configured path aliases, linting, formatting, and basic health tests.

2026-10-24 14:41:09 - TASK-1: Verified project prerequisites and access. Confirmed .env.local placeholders, Node/npm versions, better-sqlite3 installation, and documentation accessibility. Recorded PG as a proceed gap.
2026-10-24 15:20 - Implemented TASK-4: System generator. Created `app/src/shared/galaxy/system.ts`, `app/src/shared/galaxy/planet.ts`, and `app/src/shared/galaxy/config-system.ts`. Updated `app/src/shared/galaxy/types.ts`. Added statistical tests for landability and atmosphere (>80% systems) and a golden snapshot for star #0. All tests passing.
2026-10-24 15:36 - Completed TASK-6: Implemented galaxy determinism verification. Added canonical JSON helper, snapshot generation script, and a comprehensive test suite covering the star chart, systems, and surface chunks. Verified via mutation test.
2026-10-24 15:54:48 - Completed TASK-62: Implemented dual-driver Drizzle schema and repository layer with full unit tests for SQLite.
2026-10-24: Implemented PersistService with dirty-ship tracking, interval saves, and recovery. Updated Repository and Schema to support system-based loading.
