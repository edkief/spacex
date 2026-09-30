import { describe, expect, it } from 'vitest';
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_WINDOW_MAX,
  CHAT_WINDOW_MS,
  sanitizeChatText,
} from '@shared/chat';

/**
 * TASK-16: server-side chat sanitization — control characters, bidi and
 * zero-width format characters are stripped so a terminal/paste payload can
 * never ride through the log (the client's React text rendering is the
 * second layer: an HTML payload arrives as inert characters).
 */
describe('sanitizeChatText', () => {
  it('strips C0 control characters (newline, tab, NUL, bell)', () => {
    expect(sanitizeChatText('hello\x00world')).toBe('helloworld');
    expect(sanitizeChatText('line1\nline2\ttabbed')).toBe('line1line2tabbed');
    expect(sanitizeChatText('\u0007\u001b[31mred\u0000')).toBe('red');
  });

  it('strips DEL and C1 controls', () => {
    expect(sanitizeChatText('a\x7fb\u0085c')).toBe('abc');
  });

  it('strips bidi overrides and zero-width / format characters', () => {
    expect(sanitizeChatText('a\u200bb\u200ec\u202ad\u202ee\u2060f\ufeff')).toBe('abcdef');
  });

  it('trims surrounding whitespace and keeps visible text (incl. unicode)', () => {
    expect(sanitizeChatText('  padded  ')).toBe('padded');
    expect(sanitizeChatText('héllo — wörld 世界 <b>markup</b>')).toBe(
      'héllo — wörld 世界 <b>markup</b>',
    );
  });

  it('leaves an XSS payload structurally intact (client renders it inert)', () => {
    expect(sanitizeChatText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('reduces a controls-only message to the empty string', () => {
    expect(sanitizeChatText('\n\t\u0000 \u007f')).toBe('');
  });
});

describe('chat constants', () => {
  it('TASK-16: 200 chars after trim, 5 per 10 s, 100-message history', () => {
    expect(CHAT_MAX_CHARS).toBe(200);
    expect(CHAT_WINDOW_MAX).toBe(5);
    expect(CHAT_WINDOW_MS).toBe(10_000);
    expect(CHAT_HISTORY_MAX).toBe(100);
  });
});
