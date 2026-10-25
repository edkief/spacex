
export type ToastType = 'info' | 'error' | 'success';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

export const toastStore = {
  toasts: [] as Toast[],
  listeners: new Set<() => void>(),

  addToast(message: string, type: ToastType = 'info') {
    const id = Math.random().toString(36).substring(2, 11);
    this.toasts.push({ id, message, type });
    
    // Keep only last 5
    if (this.toasts.length > 5) {
      this.toasts.shift();
    }

    this.listeners.forEach((l) => l());

    setTimeout(() => {
      this.removeToast(id);
    }, 3000);
  },

  removeToast(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.listeners.forEach((l) => l());
  },

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  },
};
