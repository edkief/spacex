export type WarpState = 'idle' | 'warping-in' | 'awaiting' | 'warping-out';

export const warpStore = {
  state: 'idle' as WarpState,
  targetSystemId: null as string | null,
  listeners: new Set<() => void>(),

  setState(state: WarpState, targetSystemId: string | null = null) {
    this.state = state;
    if (targetSystemId) {
      this.targetSystemId = targetSystemId;
    }
    this.listeners.forEach((l) => l());
  },

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  },
};
