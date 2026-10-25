export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

export const connectionStore = {
  status: 'disconnected' as ConnectionStatus,
  error: null as string | null,
  listeners: new Set<(status: ConnectionStatus, error: string | null) => void>(),

  setStatus(status: ConnectionStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    this.listeners.forEach(l => l(status, error));
  },

  subscribe(l: (status: ConnectionStatus, error: string | null) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
};
