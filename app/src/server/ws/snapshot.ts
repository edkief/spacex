import type { z } from 'zod';
import type { stateSnapshotSchema } from '@shared/protocol/world.ts';

export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;
