import React from 'react';
import type { ChatStore } from '@client/net/chat';
import { CHAT_MAX_CHARS } from '@shared/chat';

interface ChatLogProps {
  store: ChatStore;
  /** Sends a trimmed, non-empty message over the WS session. */
  onSend: (text: string) => void;
}

/** '[HH:MM]' from a server-assigned ms epoch, local time. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * TASK-16: system chat log (top-left column, above the player list).
 * Last 100 messages as '[HH:MM] CALLSIGN: text' — rendered as plain React
 * TEXT (auto-escaped; no innerHTML), so an XSS payload arrives as inert
 * characters.
 *
 * The input stays hidden until Enter is pressed anywhere (gameplay flow is
 * never interrupted by an always-visible textbox); Enter in the input sends
 * and closes, Escape discards and closes. Auto-scroll pins to the bottom
 * ONLY while the user is already at the bottom.
 */
export function ChatLog({ store, onSend }: ChatLogProps) {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => store.subscribe(bump), [store]);

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const atBottom = React.useRef(true);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // New message: scroll down only if the user was already at the bottom.
  React.useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  // Enter (from anywhere) opens the input; while it is open, Enter belongs
  // to the input itself (send) and the window handler stays out.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return;
      if (e.target === inputRef.current) return;
      setOpen(true);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (): void => {
    const text = draft.trim();
    if (text) onSend(text);
    setDraft('');
    setOpen(false);
    atBottom.current = true;
  };

  const entries = store.entries;

  return (
    <div id="chat-log" style={styles.box}>
      <div
        id="chat-messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        style={styles.list}
        aria-live="polite"
      >
        {entries.map((m, i) => (
          <div key={`${m.ts}-${i}`} style={styles.line}>
            <span style={styles.time}>[{formatTime(m.ts)}]</span>{' '}
            <span style={styles.from}>{m.from}:</span> {m.text}
          </div>
        ))}
      </div>
      {open && (
        <input
          id="chat-input"
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') {
              setDraft('');
              setOpen(false);
            }
          }}
          onBlur={() => setOpen(false)}
          maxLength={CHAT_MAX_CHARS}
          placeholder="message — Enter to send, Esc to close"
          aria-label="chat message"
          style={styles.input}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    position: 'absolute',
    left: '1rem',
    top: '8rem', // below the HUD title card, above the bottom-left player list
    width: '20rem',
    display: 'flex',
    flexDirection: 'column',
    padding: '0.5rem 0.75rem',
    border: '1px solid #2a3346',
    borderRadius: 8,
    background: 'rgba(17, 21, 31, 0.85)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.8rem',
    userSelect: 'none',
  },
  list: {
    maxHeight: '11rem',
    overflowY: 'auto',
    lineHeight: 1.5,
    wordBreak: 'break-word',
  },
  line: { color: '#a8b3c5' },
  time: { color: '#5b6678' },
  from: { color: '#d6deeb' },
  input: {
    marginTop: '0.4rem',
    background: '#0b0e14',
    border: '1px solid #2a3346',
    borderRadius: 6,
    color: '#d6deeb',
    padding: '0.3rem 0.5rem',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
};
