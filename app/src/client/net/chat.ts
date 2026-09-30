import type { ChatMessage } from '@shared/protocol/schemas';
import { CHAT_HISTORY_MAX } from '@shared/chat';

type ChangeListener = () => void;

/**
 * TASK-16: client-side system chat log. Ring buffer of the last 100 messages
 * (server ts = ms epoch, strictly increasing per shard), seeded from the
 * enter_system snapshot on every join and cleared on system change via a
 * time watermark: a late frame from the OLD system (ts older than the switch)
 * can never resurrect into the new log.
 *
 * Emits only when the buffer actually changes, so the HUD never re-renders
 * on the 10 Hz entity cadence.
 */
export class ChatStore {
  private messages: ChatMessage[] = [];
  private readonly listeners = new Set<ChangeListener>();
  /** Frames with ts < watermark belong to a previous system: dropped. */
  private watermarkTs = 0;

  get entries(): readonly ChatMessage[] {
    return this.messages;
  }

  get size(): number {
    return this.messages.length;
  }

  /** One new broadcast message (also the sender's own echo). */
  append(entry: ChatMessage): void {
    if (entry.ts < this.watermarkTs) return; // stale: pre-system-change
    this.messages.push(entry);
    if (this.messages.length > CHAT_HISTORY_MAX) this.messages.shift();
    this.emit();
  }

  /**
   * enter_system snapshot: replace the whole log with the shard's history.
   * Doubles as the system-change clear (an empty snapshot empties the log)
   * and arms the watermark against stale frames from the old system.
   */
  loadSnapshot(entries: readonly ChatMessage[]): void {
    this.messages = entries.slice(-CHAT_HISTORY_MAX);
    this.watermarkTs = Date.now();
    this.emit();
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
