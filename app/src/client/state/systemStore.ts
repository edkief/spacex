export const systemStore = {
  currentSystemId: 'sol',
  listeners: new Set<() => void>(),

  setSystemId(id: string) {
    this.currentSystemId = id;
    this.listeners.forEach((l) => l());
  },

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  },
};
