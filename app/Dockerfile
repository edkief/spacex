# Drift: one image serving the built client, REST API and WebSocket from a
# single Node process (STATIC_DIR points the server at the vite build).
#
#   docker build -t drift .
#   docker run -p 3000:3000 -v drift-data:/app/data -e SESSION_SECRET=... drift

ARG NODE_VERSION=24

# --- deps: full install; better-sqlite3 compiles with node-gyp -------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- build: vite client -> dist/, bundled server -> dist-server/ ------------
FROM deps AS build
COPY . .
RUN npm run build && npm run build:server

# --- prod-deps: drop dev dependencies, keep the compiled native module ------
FROM deps AS prod-deps
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/dist \
    DB_PATH=/app/data/drift.db
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist-server/index.js"]
