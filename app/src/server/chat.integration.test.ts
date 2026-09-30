import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WsTestClient } from '@server/ws-test-client';
import { bootServer, freePort, waitReady, type Child } from '@server/server-child';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { ChatMessage, StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-16 WS integration against the REAL server process (src/server/index.ts
 * via server-child, same as the TASK-12/24 integration tests): two clients in
 * one system — every broadcast reaches EVERY in-system connection (sender
 * echo included), ts is strictly monotonic for all clients, > 5 messages /
 * 10 s from one connection is dropped with rate-limited (that sender only),
 * invalid messages (empty / > 200 after trim / non-string) come back
 * invalid-message, control characters are stripped, and a late joiner's
 * enter_system snapshot carries the shard's chat history.
 */

const GALAXY_SEED = 'chat-integration-seed-001';

let dir: string;
let child: Child;
let base: number;
/** Home system of the test players (homeSystemId is per-player — pin one). */
let SYSTEM_ID = '';
const clients: WsTestClient[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-chat-'));
  base = await freePort();
  child = bootServer({ base, dbPath: path.join(dir, 'chat.db'), galaxySeed: GALAXY_SEED });
  await waitReady(child);
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  child.child.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(callsign: string): Promise<{ token: string; homeSystemId: string }> {
  const res = await fetch(`http://127.0.0.1:${base}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; homeSystemId: string };
}

async function join(
  callsign: string,
  systemId: string,
): Promise<{ client: WsTestClient; snapshot: StateSnapshot }> {
  const { token } = await claim(callsign);
  const c = new WsTestClient(`ws://127.0.0.1:${base}/ws`);
  clients.push(c);
  await c.open();
  c.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
  c.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } });
  c.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId } });
  const enter = await c.next((m) => m.type === 'enter_system', `enter_system for ${callsign}`, 8000);
  return { client: c, snapshot: (enter.payload as { snapshot: StateSnapshot }).snapshot };
}

/** Consume the next chat broadcast (type + payload shape-checked). */
async function nextChat(c: WsTestClient, what: string, ms = 4000): Promise<ChatMessage> {
  const env = await c.next(
    (m) => {
      const p = m.payload as { text?: unknown; from?: unknown };
      return m.type === 'chat' && typeof p.text === 'string' && typeof p.from === 'string';
    },
    what,
    ms,
  );
  return env.payload as ChatMessage;
}

async function nextError(c: WsTestClient, code: string, what: string, ms = 4000): Promise<void> {
  await c.next(
    (m) => m.type === 'error' && (m.payload as { code?: string })?.code === code,
    what,
    ms,
  );
}

describe('system chat against the real server (TASK-16)', () => {
  it('delivers every message to the whole shard in order; limits; sanitizes', async () => {
    SYSTEM_ID = (await claim('ChatHost')).homeSystemId;
    const { client: a } = await join('ChatA', SYSTEM_ID);
    const { client: b } = await join('ChatB', SYSTEM_ID);
    const { client: c } = await join('ChatC', SYSTEM_ID);

    // --- 3 messages each, interleaved: all 6 delivered to EVERY other
    // client, in the SAME order everywhere, with strictly increasing
    // (monotonic) server ts. The cross-socket interleaving is server-
    // decided, so we assert set equality + per-sender order, not the exact
    // interleaving.
    for (const t of ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']) {
      (t.startsWith('a') ? a : b).send({ v: 1, type: 'chat', payload: { text: t } });
    }
    const gotA: ChatMessage[] = [];
    const gotB: ChatMessage[] = [];
    const gotC: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      gotA.push(await nextChat(a, `A got #${i + 1}`));
      gotB.push(await nextChat(b, `B got #${i + 1}`));
      gotC.push(await nextChat(c, `C got #${i + 1}`));
    }
    expect([...gotA.map((m) => m.text)].sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
    expect(gotB).toEqual(gotA); // identical order on every client
    expect(gotC).toEqual(gotA);
    const idx = (t: string) => gotA.findIndex((m) => m.text === t);
    expect(idx('a1')).toBeLessThan(idx('a2'));
    expect(idx('a2')).toBeLessThan(idx('a3'));
    expect(idx('b1')).toBeLessThan(idx('b2'));
    expect(idx('b2')).toBeLessThan(idx('b3'));
    for (let i = 1; i < gotA.length; i++) {
      expect(gotA[i].ts).toBeGreaterThan(gotA[i - 1].ts);
    }

    // --- Rate limit: A already has 3 in its 10 s window; 2 more pass, the
    // 6th within the window is dropped with rate-limited to A ONLY.
    a.send({ v: 1, type: 'chat', payload: { text: 'flood-1' } });
    a.send({ v: 1, type: 'chat', payload: { text: 'flood-2' } });
    a.send({ v: 1, type: 'chat', payload: { text: 'flood-3' } });
    expect((await nextChat(a, 'flood-1')).text).toBe('flood-1');
    expect((await nextChat(b, 'B saw flood-1')).text).toBe('flood-1');
    expect((await nextChat(a, 'flood-2')).text).toBe('flood-2');
    expect((await nextChat(b, 'B saw flood-2')).text).toBe('flood-2');
    await nextError(a, 'rate-limited', 'A rate-limited on 6th in window');
    // The dropped message never reaches the shard (no broadcast for it).
    const sawFlood3 = (cl: WsTestClient): boolean =>
      cl.messages.some(
        (m) => m.type === 'chat' && (m.payload as { text?: string }).text === 'flood-3',
      );
    expect(sawFlood3(a)).toBe(false);
    expect(sawFlood3(b)).toBe(false);

    // --- Per-connection isolation: B's window is separate, so B can still send.
    b.send({ v: 1, type: 'chat', payload: { text: 'b4' } });
    expect((await nextChat(a, 'A saw b4')).text).toBe('b4');

    // --- C (fresh window): sanitization + XSS. Control characters are
    // stripped server-side; the XSS payload passes through as inert TEXT
    // (the client renders it plain — DOM absence of <img> is asserted in
    // the Playwright spec).
    c.send({ v: 1, type: 'chat', payload: { text: 'hello\x00world\n' } });
    expect((await nextChat(a, 'sanitized')).text).toBe('helloworld');
    const XSS = '<img src=x onerror=alert(1)>';
    c.send({ v: 1, type: 'chat', payload: { text: XSS } });
    expect((await nextChat(a, 'xss message')).text).toBe(XSS);

    // --- Invalid messages: empty, empty-after-trim, > 200 after trim, and a
    // non-string text all come back invalid-message (never broadcast).
    a.send({ v: 1, type: 'chat', payload: { text: '' } });
    await nextError(a, 'invalid-message', 'empty text rejected');
    a.send({ v: 1, type: 'chat', payload: { text: ' '.repeat(201) } });
    await nextError(a, 'invalid-message', 'whitespace-only rejected');
    a.send({ v: 1, type: 'chat', payload: { text: 'x'.repeat(201) } });
    await nextError(a, 'invalid-message', 'overlong rejected');
    a.send({ v: 1, type: 'chat', payload: { text: 123 } as never });
    await nextError(a, 'invalid-message', 'non-string rejected');
    expect(
      a.messages.some((m) => m.type === 'chat' && (m.payload as { text?: unknown }).text === 123),
    ).toBe(false);
  }, 45_000);

  it('a late joiner receives the shard chat history in the enter_system snapshot', async () => {
    const { snapshot: snap } = await join('LateJoiner', SYSTEM_ID);
    expect(snap.chat.length).toBeGreaterThan(0);
    expect(snap.chat).toHaveLength(11); // 6 interleaved + flood-1/2 + b4 + sanitized + xss
    expect(snap.chat.map((m) => m.text)).toContain('flood-2');
    expect(snap.chat.some((m) => m.text === '<img src=x onerror=alert(1)>')).toBe(true);
    for (let i = 1; i < snap.chat.length; i++) {
      expect(snap.chat[i].ts).toBeGreaterThan(snap.chat[i - 1].ts);
    }
  }, 45_000);
});
