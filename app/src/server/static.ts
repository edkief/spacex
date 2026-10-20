/**
 * Static client hosting for the production image.
 *
 * Serves the built client (vite `dist/client/`) from the API process so a
 * production run is a single same-origin image: the client's `/api` fetches
 * and `/ws` upgrade hit this server directly. Vite's content-hashed `assets/`
 * are cached forever; everything else (index.html) is revalidated on each load
 * so a deploy is picked up immediately.
 */
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Mount the built client under the given directory.
 *
 * No-op when the directory does not exist (the dev/test runs never build the
 * client) so a missing `dist/client` degrades to an API-only server instead
 * of a boot failure.
 */
export async function registerStaticClient(app: FastifyInstance, root: string): Promise<void> {
  const resolved = path.resolve(root);
  await app.register(fastifyStatic, {
    root: resolved,
    prefix: "/",
    setHeaders: (reply, filePath) => {
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      reply.header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
}
