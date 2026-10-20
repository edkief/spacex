/**
 * ChatLog — TASK-16 in-system chat panel.
 *
 * Renders the last 100 messages in a top-left column above the
 * player list. The wire format `[12:03] CALLSIGN: text` is
 * assembled via `formatChatLine` (see `chat.ts`). React's auto-
 * escaping of JSX text nodes means a hostile message like
 * `<img src=x onerror=alert(1)>` is rendered as inert text — no
 * `dangerouslySetInnerHTML` is used anywhere in this file.
 *
 * ## Input UX
 *
 * The input field is hidden by default so the gameplay flow isn't
 * blocked by a persistent textbox. Pressing **Enter** (or the
 * dedicated "+" button at the right edge of the panel header)
 * expands the input. **Enter** while focused sends the message
 * AND collapses the input back to the title-only state. **Escape**
 * while focused cancels without sending.
 *
 * The input is disabled when the client isn't `online` (i.e. before
 * the WS handshake completes) so a typed-and-lost message can't be
 * silently dropped.
 *
 * ## Auto-scroll
 *
 * On append, we scroll to the bottom ONLY if the user is already at
 * (or near) the bottom. If they've scrolled up to read history, new
 * messages don't yank them back down — matches the standard "scroll
 * pinned if at bottom" pattern from chat clients.
 *
 * @see ../net/chat.ts for the store API + event shapes.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";

import { type ChatEntry, type ChatStore, formatChatLine } from "../net/chat.js";

/** Props for the chat log. */
export interface ChatLogProps {
  /** The chat store to subscribe to. Required. */
  store: ChatStore;
  /**
   * Whether the input may be sent. `false` hides the input and
   * blocks typing until the WS handshake completes. Defaults to
   * `true` so non-WS tests can exercise the UI freely.
   */
  canSend?: boolean;
  /**
   * Send hook. The component calls this when the user submits a
   * non-empty input. Defaults to a no-op so non-WS tests can render
   * the UI without wiring the DriftClient.
   */
  onSend?: (text: string) => void;
}

/** Approximate px threshold for "user is at the bottom" detection. */
const SCROLL_BOTTOM_PX = 24;

/** Whether the panel should auto-scroll on new messages. */
function isAtBottom(el: HTMLDivElement | null): boolean {
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= SCROLL_BOTTOM_PX;
}

/**
 * Top-left chat log. See file header for design notes.
 */
export function ChatLog({ store, canSend = true, onSend }: ChatLogProps): React.JSX.Element {
  // Subscribe via the snapshot so the React commit only runs when
  // the array reference changes (insert / clear / snapshot events).
  const entries = useSyncExternalStore(
    (onStoreChange) => store.subscribe(() => onStoreChange()),
    () => store.snapshot(),
    () => store.snapshot(),
  );

  const [inputOpen, setInputOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll: pinned to bottom only if the user was already
  // there. The `useLayoutEffect` runs before paint so the scroll
  // adjustment doesn't flash.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottom(el)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  // Focus the input when it expands so the user can type immediately.
  useEffect(() => {
    if (inputOpen) inputRef.current?.focus();
  }, [inputOpen]);

  // Toggle the input on Enter (global) only when no other input is
  // focused — we don't want to hijack Enter on the chat input itself.
  //
  // TASK-54: the global Enter shortcut must also yield to the
  // focused *control*. Before this fix, pressing `Enter` on a
  // star-chart node selected the system AND opened the chat input
  // (stealing the focus), which broke the keyboard-only flow.
  useEffect(() => {
    if (!canSend) return;
    const onKey = (ev: KeyboardEvent): void => {
      const active = document.activeElement;
      const inTextField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (inTextField) return;
      // A focused control owns its `Enter` key (buttons, chart
      // nodes, menu items) — the chat shortcut stands down.
      const target = ev.target;
      if (
        target instanceof Element &&
        target.closest("button, [role='button'], [role='menuitem'], a[href], [tabindex]") !== null
      ) {
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        setInputOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSend]);

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    onSend?.(text);
    setDraft("");
    setInputOpen(false);
  };

  return (
    <div
      data-testid="drift-chat-log"
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        // Below the header pill, above the player list column.
        marginTop: 56,
        width: 280,
        maxHeight: 280,
        padding: 0,
        background: "rgba(0, 0, 0, 0.55)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 6,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
        fontSize: 12,
        color: "#e6edf3",
        letterSpacing: "0.02em",
        display: "flex",
        flexDirection: "column",
        pointerEvents: "auto",
        zIndex: 1000,
      }}
    >
      <div
        data-testid="drift-chat-log-header"
        style={{
          padding: "6px 10px",
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          fontSize: 10,
          color: "#8b949e",
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>System Chat</span>
        {canSend && (
          <button
            type="button"
            data-testid="drift-chat-log-toggle"
            aria-label="Open chat input"
            onClick={() => setInputOpen((open) => !open)}
            style={{
              background: "transparent",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              color: "#e6edf3",
              borderRadius: 3,
              width: 18,
              height: 18,
              fontSize: 12,
              lineHeight: "16px",
              padding: 0,
              cursor: "pointer",
            }}
          >
            {inputOpen ? "−" : "+"}
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        data-testid="drift-chat-log-scroll"
        style={{
          padding: "6px 10px",
          flex: "1 1 auto",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          // Reserve enough room for the header + optional input.
          minHeight: 80,
          maxHeight: 220,
        }}
      >
        {entries.length === 0 ? (
          <div
            data-testid="drift-chat-log-empty"
            style={{ color: "#8b949e", fontStyle: "italic", padding: "2px 0" }}
          >
            (no messages yet)
          </div>
        ) : (
          entries.map((e) => <ChatRow key={e.id} entry={e} />)
        )}
      </div>
      {canSend && inputOpen && (
        <form
          data-testid="drift-chat-log-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            submit();
          }}
          style={{
            display: "flex",
            borderTop: "1px solid rgba(255, 255, 255, 0.06)",
            padding: 4,
            gap: 4,
          }}
        >
          <input
            ref={inputRef}
            data-testid="drift-chat-log-input"
            type="text"
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.preventDefault();
                setInputOpen(false);
                setDraft("");
              }
            }}
            placeholder="Type to chat…"
            maxLength={200}
            style={{
              flex: "1 1 auto",
              padding: "4px 8px",
              background: "rgba(255, 255, 255, 0.05)",
              border: "1px solid rgba(255, 255, 255, 0.15)",
              borderRadius: 3,
              color: "#e6edf3",
              fontFamily: "inherit",
              fontSize: 12,
              letterSpacing: "0.02em",
              outline: "none",
            }}
          />
          <button
            type="submit"
            data-testid="drift-chat-log-send"
            disabled={draft.trim().length === 0}
            style={{
              padding: "4px 10px",
              background: draft.trim().length === 0 ? "rgba(255,255,255,0.05)" : "#1f6feb",
              color: draft.trim().length === 0 ? "#8b949e" : "#ffffff",
              border: "none",
              borderRadius: 3,
              cursor: draft.trim().length === 0 ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              letterSpacing: "0.04em",
            }}
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}

/** A single chat row — text only, no HTML. */
function ChatRow({ entry }: { entry: ChatEntry }): React.JSX.Element {
  return (
    <div
      data-testid="drift-chat-log-row"
      data-author={entry.author}
      data-id={entry.id}
      style={{ wordBreak: "break-word", lineHeight: 1.4 }}
    >
      <span data-testid="drift-chat-log-line" style={{ whiteSpace: "pre-wrap" }}>
        {formatChatLine(entry)}
      </span>
    </div>
  );
}
