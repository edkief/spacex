import { Router } from './router';
import { persistService } from '../persist';

export const router = new Router({
  reapGraceMs: 60000,
  connSender: (connId, type, payload) => {
    // This will be wired up in ws.ts or similar
  }
});

// Start the reap cycle
router.startReapCycle();

export { router };
