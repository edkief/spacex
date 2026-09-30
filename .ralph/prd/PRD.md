# PRD: Drift — Open-Galaxy Browser Space Sim

Status: Draft v1 — approved executive summary, pending final sign-off
Date: 2026-08-22

## 1. App Overview, Objectives & Success Criteria

**Drift** is a browser-based, 3D WebGL multiplayer space sim. Every player owns a persistent ship and explores a shared, deterministically generated galaxy. The core differentiator is a **seamless, continuous transition from space to planet surface** — and players can **exit their ships** to explore on foot. No loading screens within a star system.

### Objectives
1. Prove seamless space ↔ orbit ↔ atmosphere ↔ ground in a browser, with no loading screens and no frame hitches beyond budget.
2. Ship a persistent, server-authoritative multiplayer sandbox (one shared galaxy, per-system player cap).
3. Give exploration direction with a minimal mine → haul → sell economy and PvE combat.

### Success Criteria
- **SC-1:** Player flies from star chart to a planet, lands, exits the ship, walks to a landmark, mines a node, re-enters, and sells at a dock with **zero loading screens** on reference hardware (mid-range laptop, WebGL2).
- **SC-2:** Two players joining from different entry points (different times, different systems) see an identical galaxy for the same `GALAXY_SEED` (determinism check, automated).
- **SC-3:** Stable sessions with 16 concurrent players in one system for ≥ 30 min (no crash, p95 tick time within budget).
- **SC-4:** 60 fps on reference mid-range laptop in space, atmosphere, and ground regimes; 30 fps mobile rendering floor with reduced draw distance.
- **SC-5:** Transition between regimes (space→orbit→atmo→ground and reverses) causes no hitch above the transition frame budget (measured via frame monitor overlay).

### Non-Goals (v1)
- Deep economy / player trading market, crafting, NPCs
- Full combat suite (armor zones, weapon heat UI, shield recharge minigames) — v1 combat is hitbox weapons + shields/hull
- Mods, user-generated content
- Space stations as social hubs (simple functional docks only)
- Voice chat, touch controls, ballistics weapon simulation
- Horizontal scale-out (multiple app instances) — designed for it, not required day 1

## 2. Target Audience

- Space-sim players who want the Elite/No Man's Sky loop in a browser tab (no install, shareable URL).
- Tech-curious players and developers who enjoy deterministic procedural worlds.
- 2-player+ casual sessions: friends drop into the same system, explore, and trade cargo.
- Secondary: WebGL/three.js engineers evaluating large-scale streaming/LOD techniques.

## 3. Competitive Landscape & Differentiation

Research note: compiled from domain knowledge of shipped titles; no live search available in this session.

| Title | Platform | Overlap | Gap Drift fills |
|---|---|---|---|
| Elite Dangerous | Desktop/console | Seamless space sim, procedural galaxy, sandbox | Not browser; on-foot surface play absent; heavy install |
| Star Citizen | Desktop | Persistent shared universe, ship sim | Not browser; no surface transitions; long wait |
| No Man's Sky | Desktop/console | Seamless space↔surface, on-foot exploration | Single-player/co-op only, not a persistent shared world; not browser |
| Star Traders: Frontiers | Browser (WebGL) | Persistent multiplayer space trading/combat | 2D top-down; no 3D seamless surface; no on-foot |
| Space Pirates & Zombies 2 | Desktop | 3D space + surface, sandbox | Not browser; weak persistent multiplayer |

**Differentiation:** (1) seamless 3D space↔surface *in the browser*; (2) on-foot mode with re-entry inside a persistent shared world; (3) deterministic seed-reproducible galaxy any client can reconstruct; (4) light day-1 infra (single app instance hosts unlimited systems in-process).

## 4. Core Features & Functional Requirements

Requirement IDs are `TASK-${ID}`. `TASK-1` is reserved for prerequisite verification; feature work starts at `TASK-2`.

### 4.1 Deterministic Procedural Galaxy
- **TASK-2:** Shared PRNG/hash library (client+server, pure TS): seeded PRNG (e.g. SplitMix64/xoshiro), deterministic hash→value functions, no Math.random in gen paths. *Accept: same seed → identical values in node and browser (unit-tested).*
- **TASK-3:** Star generator: N stars with name, class (spectral), position (galactic coords), system count, seeded layout. *Accept: star list identical across runs/clients.*
- **TASK-4:** System generator: planets/moons (class, radius, atmosphere presence), dock placement, resource deposit fields, rogue-AI spawn fields. *Accept: planet table for a given system hash is stable.*
- **TASK-5:** Surface generator: chunked heightmap + biomes + resource node placement + landing pad placement, derived from (seed, planet, chunk). *Accept: same chunk yields identical terrain/nodes from any client.*
- **TASK-6:** Determinism verification: snapshot tests (star chart, system, sample chunks) + two-client e2e comparison. *Accept: SC-2 passes in CI.*
- **TASK-7:** Star chart UI: list/search of systems, class + distance display, select target system. *Accept: player can open chart, search, and select a system.*
- **TASK-8:** Inter-system warp: nav-menu warp with brief in-world transition (no loading screen, no black screen); session re-routed to target system shard. *Accept: warp completes without a loading screen; state persists.*

### 4.2 Multiplayer Core (server-authoritative)
- **TASK-9:** WS protocol: typed, versioned message schema (client↔server), handshake, ping/pong, error codes. *Accept: schema validated both directions; unknown version rejected.*
- **TASK-10:** Callsign auth: claim unique callsign → signed (HMAC) session token with expiry; token required for all gameplay messages. *Accept: callsign unique; expired/invalid token rejected with re-auth flow.*
- **TASK-11:** Galaxy router in a single app instance: in-process system shards (spawn on first join, idle-reap), session→shard dispatch, 16-player cap per system with queue/reject message. *Accept: N systems coexist in one process; 17th player gets a clear "system full" response.*
- **TASK-12:** System shard lifecycle: load persisted state from DB, broadcast join/leave presence, save-on-shutdown. *Accept: restart preserves ships/cargo/credits; presence events observed by clients.*
- **TASK-13:** Authoritative sim: fixed 20 Hz server tick; 10 Hz entity snapshot broadcast; interpolation buffer on client. *Accept: p95 tick within budget at 16 players; motion smooth at 10 Hz snapshots.*
- **TASK-14:** Client prediction + reconciliation: predicted local ship movement, server correction without visible snap. *Accept: 150 ms simulated latency shows no rubber-banding beyond threshold (measured).*
- **TASK-15:** Presence & system list: in-system player list, join/leave toasts, system occupancy in star chart. *Accept: joins/leaves visible to all within 1 tick.*
- **TASK-16:** Text chat: system channel, message history (last 100), client-side rate limit, server-side validation. *Accept: chat round-trips; spam limited; no HTML/script injection rendered.*
- **TASK-17:** Reconnect & resync: on WS drop, client re-auths and receives full state resync of its shard. *Accept: kill network 5 s → player restored in same position, sim continues.*
- **TASK-18:** 16-player load/stability test: scripted 16 clients (headless) in one system, mixed regimes, 30 min. *Accept: SC-3 passes; no unhandled errors.*

### 4.3 Ships & Flight
- **TASK-19:** Ship catalog: 3 classes (e.g. Scout / Freighter / Interceptor) with stats: mass, max velocity, acceleration, cargo slots, weapon mounts, shield capacity. *Accept: catalog is data-driven; stats drive sim and UI.*
- **TASK-20:** Ship acquisition: starter ship on callsign claim; purchase of other classes with credits at dock. *Accept: buying updates ship + deducts credits persistently.*
- **TASK-21:** Persistent customization: per-ship livery (color scheme) chosen at dock, stored, rendered for all clients. *Accept: livery survives restart and is visible to others.*
- **TASK-22:** Flight model (shared physics module, server-authoritative): Newtonian-ish space flight, atmospheric flight (drag/lift simplified), VTOL landing on pads. *Accept: same module runs server sim and client prediction; landing on pad succeeds in test.*
- **TASK-23:** Damage model: hull + shield values; damage events; repair at dock (cost). *Accept: hull 0 → destroyed state; dock repair restores to full.*
- **TASK-24:** Ship state persistence: position, velocity, cargo, hull/shields, livery; saved on dock, damage milestones, and interval. *Accept: restart restores ship within tolerance.*

### 4.4 Seamless Transitions & Streaming
- **TASK-25:** Regime manager: state machine space → orbit → atmosphere → surface (and reverses), shared by rendering, physics, and camera. *Accept: regime transitions fire exactly once per boundary crossing.*
- **TASK-26:** Streaming pipeline: chunked sector loading around camera (space sectors + terrain chunks), LOD tiers, impostors for distant objects, pop-in budget. *Accept: no pop-in within budget distance; memory bounded (measured).*
- **TASK-27:** Camera handoff: continuous camera across ship cockpit → external → orbit → ground third-person; no cut, no reset. *Accept: SC-5; handoff visually verified via Playwright screenshots.*
- **TASK-28:** Atmosphere entry/exit: boundary by planet radius + atmosphere presence; drag ramps in/out; no discontinuity in velocity. *Accept: entry/exit velocity continuous (unit-tested boundary).*
- **TASK-29:** Landing pads: pad detection, proximity hint, VTOL auto-landing assist, "landed" state gates egress. *Accept: pad approach → landed state; egress blocked while not landed.*
- **TASK-30:** Transition hitch budget: frame monitor flags any frame > budget during regime change; tuning pass until SC-5 holds. *Accept: 0 flagged frames over 50 scripted transitions.*

### 4.5 On-Foot Mode
- **TASK-31:** Egress: at a landed ship, "Exit ship" → third-person character spawns at ship hatch, camera handoff. *Accept: egress only when landed; ship remains where parked.*
- **TASK-32:** Character movement: walk/run, terrain collision, slopes, simple obstacle avoidance; input map shared with ship controls where sensible. *Accept: character traverses generated terrain without getting stuck (test path).*
- **TASK-33:** Interaction: proximity prompt to inspect/interact with landmarks, resource nodes, and objects; inspect shows name + state. *Accept: prompt appears within interact radius; action resolves server-validated.*
- **TASK-34:** Inventory: small on-foot inventory (e.g. 6 slots), pick up placed resources, weight limit; transfer to ship hold on re-entry or at ship. *Accept: pickup → inventory → ship hold flow verified; overflow blocked.*
- **TASK-35:** Re-entry: at any time, walk to ship → "Enter ship" → camera handoff back; no loading. *Accept: re-entry seamless; character state persisted (inventory merged to hold).*
- **TASK-36:** On-foot multiplayer: other players' characters visible on surface with movement sync; egress/re-entry events broadcast. *Accept: two players see each other's characters on foot in e2e.*

### 4.6 Resource Loop & Economy
- **TASK-37:** Resource nodes: seeded surface nodes with type, quantity, respawn timer; depletion persisted. *Accept: node depleted → respawn after timer; state survives restart.*
- **TASK-38:** Mining: interact + hold to extract; progress feedback; yield into on-foot inventory. *Accept: full extraction matches node yield; interrupted mining resumes.*
- **TASK-39:** Cargo model: ship hold slots by class; on-foot inventory ↔ hold transfer rules (weight/type). *Accept: transfer rules enforced client+server.*
- **TASK-40:** Dock selling: dock menu lists cargo + prices; sell → credits. *Accept: sell updates credits + empties cargo persistently.*
- **TASK-41:** Credits: balance persisted; spend on ships (TASK-20) and repairs (TASK-23); no debt. *Accept: insufficient funds blocked with clear message.*

### 4.7 Combat & PvE
- **TASK-42:** Combat core (server-authoritative): hitbox weapons, damage pipeline (shield first, then hull), hit events, kill events; identical rules vs AI and players. *Accept: damage ordering unit-tested; kill event broadcast.*
- **TASK-43:** Weapons: laser (instant, energy cost, cooldown) and missiles (guided, flight time, homing lock). *Accept: both weapons fire, track, and deal damage per stats; cooldowns enforced server-side.*
- **TASK-44:** Targeting: target lock on visible ships; target UI (distance, bearing, shields/hull). *Accept: lock requires facing + range; UI updates ≥ 5 Hz.*
- **TASK-45:** Rogue AI ships: deterministic per-system placement; patrol → aggro → engage state machine. *Accept: AI placement stable per seed; aggro triggers within threat range.*
- **TASK-46:** AI combat behavior: acquire, maintain range per class, fire weapons, evade (basic), retreat at low shields. *Accept: scripted duel vs AI completes without desync/errors.*
- **TASK-47:** PvP parity: player targets use the exact same combat pipeline as AI targets; no separate PvP toggle (PvE-focused world, but combat rules identical). *Accept: e2e duel between two test clients matches AI-vs-player damage rules.*
- **TASK-48:** Surface hazards: environmental on-foot hazards (e.g. toxic vents, falling rocks) with damage; hazard placement seeded. *Accept: hazard deals damage; death/respawn handled.*
- **TASK-49:** Destruction & respawn: hull 0 → ship destroyed; player respawns at nearest dock in a starter ship; cargo lost; destroyed hull remains as wreck (impostor). *Accept: respawn flow verified; wreck visible and static.*
- **TASK-50:** Combat HUD: shields/hull bars, target card, weapon status, threat indicator. *Accept: HUD reflects server state; no stale values > 1 s.*

### 4.8 UI / UX
- **TASK-51:** Ship HUD: velocity, nav (target + range), shields/hull, cargo, weapon status, regime indicator. *Accept: all elements data-bound to sim state.*
- **TASK-52:** On-foot HUD: interact prompt, inventory strip, objective hint (nearest node/landmark). *Accept: HUD appears in surface regime only.*
- **TASK-53:** Menu shell: callsign entry, star chart, dock menu (buy/sell/repair/livery), system list, chat panel, controls reference. *Accept: every menu reachable without leaving sim state where possible (ESC layer).*
- **TASK-54:** Accessibility: WCAG-contrast HUD text, scalable UI text (S/M/L), colorblind-safe damage/target indicators (shapes, not only hue). *Accept: contrast check passes; text scale persists in settings.*
- **TASK-55:** Settings: quality presets (draw distance, LOD bias, shadows), controls remap (basic), text scale; persisted client-side. *Accept: presets persist across reload; quality preset measurably changes frame time.*
- **TASK-56:** First-run experience: single initial asset load (only load allowed), then zero loading screens; callsign flow; 30-second onboarding hints. *Accept: first paint → playable in one load; no subsequent full-page loads.*

### 4.9 Performance
- **TASK-57:** Frame monitor: client-side stats overlay (fps, frame time, hitches, draw calls, streaming state) toggleable in settings. *Accept: overlay data drives SC-4/SC-5 verification.*
- **TASK-58:** LOD/impostor tuning: draw-call and memory budgets per regime; tuning pass to hit budgets. *Accept: budgets met in space/atmo/ground (measured via overlay).*
- **TASK-59:** Mobile rendering profile: auto-detect → 30 fps target, reduced draw distance, no shadows; keyboard/mouse controls only. *Accept: 30 fps floor on reference mobile profile (headless approximation + manual check).*
- **TASK-60:** Server tick budget: 16 players, 20 Hz, p95 tick < 30 ms on reference server hardware. *Accept: load test (TASK-18) reports within budget.*
- **TASK-61:** Reference-hardware verification: scripted SC-1/SC-4/SC-5 run on mid-range laptop with results recorded (screenshots + stats export). *Accept: results archived under .agent/screenshots with pass/fail.*

### 4.10 Data & Persistence
- **TASK-62:** Data layer: Drizzle schema (SQLite + Postgres drivers from one schema definition): `players`, `ships`, `cargo_items`, `sessions`, `resource_node_state`, `system_registry`. *Accept: schema compiles against both drivers; migrations run on SQLite locally.*
- **TASK-63:** Persistence service: save points (dock, damage milestone, interval, shard shutdown), load on shard spawn; only mutable state stored — all geometry derived from seed. *Accept: kill -9 server → restart → state intact within tolerance.*

### 4.11 Security
- **TASK-64:** Input validation: zod schemas on every inbound WS message + REST body; reject with structured error. *Accept: fuzzed/malformed messages rejected without crash.*
- **TASK-65:** Rate limiting: per-connection message rate, chat rate, chat length; exponential backoff on violation. *Accept: sustained flood → throttled, connection eventually dropped.*
- **TASK-66:** Session integrity: HMAC-signed tokens, expiry, revocation on callsign re-claim; tokens never logged. *Accept: tampered/old tokens rejected; no token in logs.*
- **TASK-67:** Cheat resistance: server validates movement (max speed/accel per class, no teleport), weapon cooldowns/energy server-side, interact ranges server-side. *Accept: client-side exploit attempts (teleport packet, rapid fire) neutralized server-side.*

### 4.12 Engineering & Verification
- **TASK-68:** Project scaffold: TS monorepo under `app/` (client `src/client`, server `src/server`, shared `src/shared`), Vite, npm scripts (dev/build/test/lint/typecheck), eslint + prettier configured. *Accept: `npm run dev` serves client + WS; all scripts run clean.*
- **TASK-69:** Documentation: README (setup, env vars, architecture diagram in text), protocol doc (message types), dev notes (regime manager, streaming pipeline). *Accept: a new dev can run the stack from README alone.*
- **TASK-70:** E2E harness (Playwright): two headless clients join same system, verify mutual presence, ship movement sync, chat; WebGL via headless chromium. *Accept: e2e suite green in CI.*
- **TASK-71:** Determinism test suite: unit snapshot tests for PRNG, stars, systems, chunks + two-client galaxy comparison e2e. *Accept: SC-2 covered in CI.*

## 5. Key User Flows

**F-1 First launch:** Open URL → initial asset load → pick callsign (unique) → spawn in starter ship at home dock → onboarding hints → free flight. *(Only load in the game's life.)*

**F-2 Explore & resource loop:** Open star chart → select planet system (warp, brief in-world transition) → approach planet → seamless orbit entry → atmosphere (drag ramps) → land on pad (VTOL) → exit ship → walk to resource node → mine into inventory → re-enter ship → transfer to hold → fly to dock → sell for credits. *Zero loading screens end-to-end.*

**F-3 Combat:** Rogue AI ships patrol the system → target lock → laser/missile engagement (shields then hull) → AI evades/retreats → victory (salvage-less in v1: just XP-free) or retreat to dock → repair → respawn flow on destruction.

**F-4 Social:** Join system (cap 16) → see others in space/ground → system chat → watch/interact with other players on foot → leave system → chart shows occupancy.

**F-5 Reconnect:** Network drops → client detects → re-auth with token → full shard resync → continues in same position.

**Error states:** System full → queue/reject message; invalid callsign → inline error; warp to full system → stay in place with toast; server unreachable → retry screen with backoff (the one UI allowed outside the sim).

## 6. Technical Stack Recommendations

| Concern | Choice | Rationale |
|---|---|---|
| 3D engine | three.js (WebGL2; WebGPURenderer as progressive enhancement) | Ecosystem, control over custom streaming/LOD pipeline |
| Client bundle | Vite + React (menus/HUD) + TypeScript | Existing scaffold; React only for DOM UI, three.js owns canvas |
| Server | Node.js 22 + Fastify (REST) + ws (WebSocket) + TypeScript | Shared TS with client; Fastify for account/dock REST |
| Sim | Fixed 20 Hz tick, 10 Hz snapshots, shared physics module | Deterministic-ish authority, simple client prediction |
| Data | Drizzle ORM over better-sqlite3 (local) / Postgres (prod) | One schema, both drivers; no external service locally |
| Validation | zod (messages + REST) | Shared schemas client/server |
| Tests | Vitest (unit/integration), Playwright (e2e, headless chromium) | Existing config; e2e covers multiplayer presence |
| Tooling | eslint + prettier + tsc --noEmit | Matches AGENTS.md quality bar |
| Env | dotenv loading `PROJECT_ROOT/.env.local` | See §7 |

## 7. Prerequisites & Access

- **Database:** SQLite (file at `DB_PATH`) — no service required; verified installable via npm (`better-sqlite3`). Postgres for prod — **no PG instance available in this dev sandbox** (open gap; decision: *proceed* — PG parity is verified via Drizzle dual-driver unit tests; live PG validation is post-v1).
- **MCPs:** configured in `.mcp.json`: `playwright` (e2e), `context7` (docs), `sequential-thinking` (planning). Availability/auth verified at TASK-1.
- **Service docs:** three.js — https://threejs.org/docs/ ; Fastify — https://fastify.dev/docs/ ; ws — https://github.com/websockets/ws ; Drizzle — https://orm.drizzle.team/ ; better-sqlite3 — https://github.com/WiseLibs/better-sqlite3
- **Environment variables** (placeholders written to `PROJECT_ROOT/.env.local`; **user must fill real values manually**):
  - `PORT` (server port; default 3000)
  - `SESSION_SECRET` — HMAC key for session tokens; **fill manually, never commit real value**
  - `GALAXY_SEED` — deterministic galaxy seed (safe default included)
  - `DB_DRIVER` — `sqlite` | `postgres`
  - `DB_PATH` — SQLite file path (default `./data/drift.db`)
  - `DATABASE_URL` — Postgres connection string (prod only); **fill manually**
  - `SYSTEM_INSTANCE_COUNT` — max concurrent in-process system shards (default 3)
  - `WS_PATH` — WebSocket endpoint path (default `/ws`)
- **Test users:** none (callsign-only). E2E uses disposable callsigns `TEST-ALPHA` / `TEST-BRAVO`; no passwords exist in the system.
- **Open gaps & decisions:**
  - No live Postgres in sandbox → *proceed* (recorded above).
  - Headless CI has limited WebGL fidelity → perf success criteria (SC-4/SC-5) verified on reference hardware with frame monitor; CI runs e2e with headless chromium (functional, not perf) → *proceed*.

## 8. Conceptual Data Model

Geometry (stars, planets, terrain, node *positions*) is **derived from seed, never stored**. Only mutable state is persisted.

- `players`: `id` (uuid pk), `callsign` (text, unique), `credits` (int, default 500), `home_system_id` (text), `created_at` (timestamptz)
- `ships`: `id` (uuid pk), `owner_id` (fk players), `class_id` (text: scout|freighter|interceptor), `livery` (json), `hull` (real), `shields` (real), `position` (json {systemId, x,y,z}), `velocity` (json {x,y,z}), `state` (enum: docked|flying|onfoot|destroyed), `updated_at`
- `cargo_items`: `id` (uuid pk), `ship_id` (fk ships), `resource_type` (text), `quantity` (int), unique(ship_id, resource_type)
- `sessions`: `token_hash` (text pk), `player_id` (fk players), `system_id` (text, nullable), `created_at`, `expires_at`
- `resource_node_state`: `node_id` (text pk = hash(seed, planet, nodeIndex)), `quantity_remaining` (int), `respawn_at` (timestamptz, nullable)
- `system_registry`: `system_id` (text pk = hash of system coords), `name` (text), `shard_active` (bool), `last_active_at`

## 9. UI Design Principles

- Diegetic-first HUD: minimal chrome, high-contrast text (WCAG AA), scalable (S/M/L).
- Sim never pauses for menus: ESC layer overlays; nav (chart/dock/chat) available without leaving the world.
- Colorblind-safe indicators: shapes + icons alongside hue for damage/target states.
- One loading screen ever (first asset load); every subsequent transition is in-world.
- Clear failure states: system full, insufficient funds, server unreachable — always with a next action.

## 10. Security Considerations

- Server-authoritative everything: movement bounds, weapon rules, interact ranges, cargo transfers, credits — client input is never trusted (TASK-67).
- Session tokens HMAC-signed with `SESSION_SECRET` (env only), short expiry, revocable; never logged (TASK-66).
- All inbound messages validated (zod) and rate-limited (TASK-64/65); chat sanitized, rendered as text only.
- Same-origin deployment (Vite proxy → server); WS origin check; no CORS for cross-origin WS.
- No secrets in client bundle; `.env.local` git-ignored; PRD/tasks contain names only, never values.
- Callsign re-claim revokes old sessions (prevents session hijack via re-claim).

## 11. Development Phases / Milestones

- **M0 Scaffold & determinism** (TASK-68, 69, 2, 3, 4, 5, 6, 71): repo, PRNG, galaxy gen, determinism tests.
- **M1 Single-system multiplayer** (TASK-9, 10, 13, 14, 15, 16, 17, 19, 20, 21, 22, 24, 62, 63, 64, 65, 66, 67, 70): protocol, auth, router (single shard), ships, flight, persistence, security, e2e presence.
- **M2 Seamless transitions & on-foot** (TASK-25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 51, 52, 56): regime manager, streaming, camera handoffs, on-foot mode.
- **M3 Economy** (TASK-37, 38, 39, 40, 41, 53): resource loop, dock menus, credits.
- **M4 Combat & PvE** (TASK-42–50, 54): combat core, weapons, AI, hazards, destruction, HUD, a11y.
- **M5 Multi-system, performance, polish** (TASK-7, 8, 11, 12, 18, 55, 57, 58, 59, 60, 61): router multi-shard, warp, load test, perf tuning, reference verification.

## 12. Assumptions & Dependencies

- One Node process hosts unlimited in-process system shards for v1; horizontal scale-out (extra app instances + sticky routing) is post-v1.
- 20 Hz sim / 10 Hz snapshot rates are sufficient for 16 players; revisit if TASK-60 fails.
- WebGPU is enhancement only; WebGL2 is the guaranteed baseline (mid-range laptop).
- No voice chat, no crafting, no NPCs, no trading market, no touch controls, no ballistics sim (non-goals).
- Ship destruction: player respawns at nearest dock in a starter ship; cargo lost; wreck remains as static impostor.
- PvP uses the identical pipeline as PvE; the world is PvE-focused (AI ships are the common threat).
- Determinism requirement applies to galaxy *generation*, not to sim outcomes (sim is server-authoritative, not lockstep).
- Dependencies: Node 22, npm, three.js, Fastify, ws, Drizzle, better-sqlite3, zod, Vite, React, Vitest, Playwright. No external paid services.
- AGENTS.md quality bar applies: one task per invocation, unit tests, Playwright smoke for UI tasks, screenshots, tsc + eslint + prettier green.
