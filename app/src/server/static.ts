import path from 'path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built client (vite `dist/`) from the API process, so production
 * runs as one same-origin image: the client's `/api` fetches and `/ws`
 * upgrade hit this server directly. Vite's content-hashed `assets/` are
 * cached forever; everything else (index.html) is revalidated each load so
 * a deploy is picked up immediately.
 */
export async function registerStaticClient(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: path.resolve(root),
    setHeaders: (reply, filePath) => {
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
