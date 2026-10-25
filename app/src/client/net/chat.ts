export interface ChatMessage {
  from: string;
  text: string;
  ts: number;
}

class SimpleEventEmitter {
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

  on(event: string, listener: (...args: any[]) => void) {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  off(event: string, listener: (...args: any[]) => void) {
    const list = this.listeners.get(event);
    if (list) {
      this.listeners.set(
        event,
        list.filter((l) => l !== listener),
      );
    }
  }

  emit(event: string, ...args: any[]) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach((l) => l(...args));
    }
  }
}

export class ChatStore extends SimpleEventEmitter {
  private messages: ChatMessage[] = [];
  private readonly maxMessages = 100;

  addMessage(msg: ChatMessage) {
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    this.emit('update', this.messages);
  }

  getMessages() {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
    this.emit('update', this.messages);
  }
}

export const chatStore = new ChatStore();
