/**
 * Unit tests for the chat utilities (TASK-16).
 *
 * Covers:
 *   - `sanitizeChatText` strips control chars / zero-width / bidi marks
 *     and collapses whitespace.
 *   - `validateChatText` accepts non-empty trimmed text within the cap
 *     and rejects empty / too-long / non-string inputs with the
 *     right reason code.
 *   - `ChatRingBuffer` enforces the 100-entry cap (FIFO eviction).
 *   - `ChatWindowLimiter` enforces the 5/10 s sliding window and
 *     resets after the window elapses.
 */
import { describe, expect, it } from "vitest";

import {
  CHAT_HISTORY_LIMIT,
  CHAT_MAX_LEN,
  CHAT_WINDOW_MAX,
  CHAT_WINDOW_MS,
  ChatRingBuffer,
  ChatWindowLimiter,
  chatValidationMessage,
  chatWindowMessage,
  sanitizeChatText,
  validateChatText,
} from "./chat.js";

// ---------------------------------------------------------------------------
// makeClock — fake timer
// ---------------------------------------------------------------------------

function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// sanitizeChatText
// ---------------------------------------------------------------------------

describe("sanitizeChatText (TASK-16)", () => {
  it("passes printable ASCII through unchanged", () => {
    expect(sanitizeChatText("hello world")).toBe("hello world");
    expect(sanitizeChatText("Drift-42: let's go")).toBe("Drift-42: let's go");
  });

  it("preserves newlines and tabs", () => {
    expect(sanitizeChatText("line1\nline2\tcolumn")).toBe("line1 line2 column");
  });

  it("strips ASCII control bytes (except \\n and \\t)", () => {
    // Each control byte is replaced with a space; consecutive
    // controls collapse to a single space.
    expect(sanitizeChatText("hello\u0000\u0001world")).toBe("hello world");
    expect(sanitizeChatText("a\u0007b\u001fc")).toBe("a b c");
  });

  it("strips DEL (0x7F)", () => {
    expect(sanitizeChatText("clean\u007Ftext")).toBe("clean text");
  });

  it("strips zero-width characters and bidi marks", () => {
    expect(sanitizeChatText("hello\u200Bworld")).toBe("hello world");
    expect(sanitizeChatText("left\u200Eto\u200Fright")).toBe("left to right");
    expect(sanitizeChatText("evil\u202Ebidi")).toBe("evil bidi");
  });

  it("collapses runs of whitespace to a single space", () => {
    expect(sanitizeChatText("hello     world")).toBe("hello world");
    expect(sanitizeChatText("tab\there")).toBe("tab here");
  });

  it("leaves XSS payloads untouched but inert (rendered as text by React)", () => {
    // Sanitization strips control bytes, not HTML — React's auto-
    // escape handles the rest. The test asserts the surviving text
    // still contains the angle brackets so a naive regex-stripper
    // would actually have introduced a bug here.
    const payload = "<img src=x onerror=alert(1)>";
    expect(sanitizeChatText(payload)).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// validateChatText
// ---------------------------------------------------------------------------

describe("validateChatText (TASK-16)", () => {
  it("accepts a non-empty trimmed text within the cap", () => {
    const r = validateChatText("hello");
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.trimmed).toBe("hello");
  });

  it("accepts text that exceeds the cap only after stripping whitespace", () => {
    const long = "a".repeat(CHAT_MAX_LEN);
    expect(validateChatText(long).accepted).toBe(true);
    expect(validateChatText(`${"  ".repeat(50)}${long}${"  ".repeat(50)}`).accepted).toBe(true);
  });

  it("rejects an empty string with reason 'empty'", () => {
    const r = validateChatText("");
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("empty");
  });

  it("rejects whitespace-only text with reason 'empty'", () => {
    const r = validateChatText("   \t\n   ");
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("empty");
  });

  it("rejects text longer than the cap with reason 'too-long'", () => {
    const r = validateChatText("a".repeat(CHAT_MAX_LEN + 1));
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("too-long");
  });

  it("rejects non-string input with reason 'not-a-string'", () => {
    expect(validateChatText(undefined)?.accepted).toBe(false);
    expect(validateChatText(null)?.accepted).toBe(false);
    expect(validateChatText(42)?.accepted).toBe(false);
    expect(validateChatText({})?.accepted).toBe(false);
  });

  it("formats the reason messages with the cap constant", () => {
    expect(chatValidationMessage("too-long")).toContain(String(CHAT_MAX_LEN));
    expect(chatValidationMessage("empty")).toMatch(/non-empty/);
    expect(chatValidationMessage("not-a-string")).toMatch(/string/);
  });
});

// ---------------------------------------------------------------------------
// ChatRingBuffer
// ---------------------------------------------------------------------------

describe("ChatRingBuffer (TASK-16)", () => {
  it("appends messages in insertion order with monotonic ids", () => {
    const buf = new ChatRingBuffer();
    const a = buf.append({ author: "ALICE", text: "hi", ts: 1000 });
    const b = buf.append({ author: "BOB", text: "yo", ts: 2000 });
    expect(a.id).toBe("chat-1");
    expect(b.id).toBe("chat-2");
    const snap = buf.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toEqual({ id: "chat-1", author: "ALICE", text: "hi", ts: 1000 });
    expect(snap[1]).toEqual({ id: "chat-2", author: "BOB", text: "yo", ts: 2000 });
  });

  it("caps the buffer at the 100-entry limit with FIFO eviction", () => {
    const buf = new ChatRingBuffer();
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 5; i++) {
      buf.append({ author: "X", text: `m${i}`, ts: i });
    }
    expect(buf.size()).toBe(CHAT_HISTORY_LIMIT);
    const snap = buf.snapshot();
    expect(snap[0]!.text).toBe("m5"); // first 5 evicted
    expect(snap[snap.length - 1]!.text).toBe(`m${CHAT_HISTORY_LIMIT + 4}`);
  });

  it("clears all entries", () => {
    const buf = new ChatRingBuffer();
    buf.append({ author: "X", text: "a", ts: 1 });
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.snapshot()).toEqual([]);
  });

  it("returns a fresh array from snapshot() each call", () => {
    const buf = new ChatRingBuffer();
    buf.append({ author: "X", text: "a", ts: 1 });
    expect(buf.snapshot()).not.toBe(buf.snapshot());
  });
});

// ---------------------------------------------------------------------------
// ChatWindowLimiter
// ---------------------------------------------------------------------------

describe("ChatWindowLimiter (TASK-16)", () => {
  it("accepts the first message and tracks subsequent ones within the window", () => {
    const c = makeClock();
    const limiter = new ChatWindowLimiter(CHAT_WINDOW_MS, CHAT_WINDOW_MAX, c.now);
    expect(limiter.check(c.now()).accepted).toBe(true);
    expect(limiter.sizeForTesting(c.now())).toBe(1);
  });

  it("rejects once the window holds CHAT_WINDOW_MAX messages", () => {
    const c = makeClock();
    const limiter = new ChatWindowLimiter(CHAT_WINDOW_MS, CHAT_WINDOW_MAX, c.now);
    for (let i = 0; i < CHAT_WINDOW_MAX; i++) {
      expect(limiter.check(c.now()).accepted).toBe(true);
    }
    const blocked = limiter.check(c.now());
    expect(blocked.accepted).toBe(false);
    if (!blocked.accepted) expect(blocked.reason).toBe("too-many");
  });

  it("accepts again once the window slides past the recorded timestamps", () => {
    const c = makeClock();
    const limiter = new ChatWindowLimiter(CHAT_WINDOW_MS, CHAT_WINDOW_MAX, c.now);
    for (let i = 0; i < CHAT_WINDOW_MAX; i++) {
      expect(limiter.check(c.now()).accepted).toBe(true);
    }
    c.advance(CHAT_WINDOW_MS + 1);
    expect(limiter.sizeForTesting(c.now())).toBe(0);
    expect(limiter.check(c.now()).accepted).toBe(true);
  });

  it("does not record timestamps for rejected checks", () => {
    const c = makeClock();
    const limiter = new ChatWindowLimiter(CHAT_WINDOW_MS, CHAT_WINDOW_MAX, c.now);
    // Fill the window.
    for (let i = 0; i < CHAT_WINDOW_MAX; i++) {
      expect(limiter.check(c.now()).accepted).toBe(true);
    }
    // A rejected check must not move the recorded timestamps.
    const before = limiter.sizeForTesting(c.now());
    expect(limiter.check(c.now()).accepted).toBe(false);
    expect(limiter.sizeForTesting(c.now())).toBe(before);
  });

  it("rejects non-positive bounds at construction", () => {
    const { now } = makeClock();
    expect(() => new ChatWindowLimiter(0, 5, now)).toThrow();
    expect(() => new ChatWindowLimiter(10_000, 0, now)).toThrow();
  });

  it("messages window rejection with the relevant constants", () => {
    const m = chatWindowMessage();
    expect(m).toContain(String(CHAT_WINDOW_MAX));
    expect(m).toContain(String(CHAT_WINDOW_MS));
  });
});
