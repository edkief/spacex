### E2E Tests: TASK-70 self-contained harness

**Suite ID:** `DRIFT-E2E`
**Feature:** real-server multiplayer harness (core flow, presence, chat)

Run: `npm run test:e2e` — each test file boots its own dev server (random
free ports, tmp sqlite DB) via `fixtures.ts`; no pre-started `npm run dev`.

---

## Test Case: `DRIFT-E2E-001` — core flow: claim → session → join → starfield → player list

**Priority:** `critical`

**Description:** claim a callsign through the form; the app opens the WS
session and joins the home system; the canvas renders a non-uniform
starfield (headless WebGL, verified by GL readPixels luminance variance over
32x32 regions); the player list shows the callsign with "(you)".

**Key verification points:**
- `#sys-id` shows the system + occupancy
- canvas pixel variance > 1 (not a black/flat screen)
- zero console/page errors

## Test Case: `DRIFT-E2E-002` — two contexts in one system see each other in the presence list

**Priority:** `critical`

**Description:** two independent browser contexts claim and join one system
(second via `?sys=` override); both player lists show both callsigns.

## Test Case: `DRIFT-E2E-003` — chat: message from A appears in B within 2 s

**Priority:** `critical`

**Description:** A sends a chat message; B's log shows it within 2 s
(delivery measured after A's local send), and A's log shows it too.
