import { describe, it, expect } from 'vitest';
import { createApp, GALAXY_SEED } from './app';

describe('Server Health', () => {
  it('should return 200 and the galaxy seed at /api/health', async () => {
    const fastify = createApp();
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);
    expect(payload).toEqual({
      ok: true,
      galaxySeed: GALAXY_SEED,
    });
  });
});
