# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build-dependencies

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Preserve npm's workspace graph and install only from the root lockfile.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

FROM build-dependencies AS build-source

COPY packages/contracts packages/contracts
COPY backend backend
COPY frontend frontend

FROM build-source AS build

# npm hoists workspace dependencies to the root. Stage that locked tree
# beneath the backend so `npm pack` can prune it to the declared bundled
# production dependency closure.
RUN npm run build \
  && cp -a /app/node_modules/. /app/backend/node_modules/ \
  && npm pkg delete --workspace @drawoff/backend devDependencies scripts \
  && npm pkg set --workspace @drawoff/backend \
    'bundledDependencies[0]=@fastify/cors' \
    'bundledDependencies[1]=@fastify/static' \
    'bundledDependencies[2]=better-sqlite3' \
    'bundledDependencies[3]=fastify' \
    'bundledDependencies[4]=kysely' \
    'bundledDependencies[5]=socket.io' \
  && mkdir -p /app/artifacts \
  && npm pack --workspace @drawoff/backend --pack-destination /app/artifacts

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=sqlite:/var/lib/drawoff/drawoff.sqlite \
    FRONTEND_ASSETS_DIR=/app/frontend

WORKDIR /app
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/node_modules/zod ./packages/contracts/node_modules/zod
COPY --from=build --chown=node:node /app/artifacts/*.tgz /tmp/backend.tgz
COPY --from=build --chown=node:node /app/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node /tmp/better_sqlite3.node
COPY --from=build --chown=node:node /app/frontend/dist/client ./frontend
RUN mkdir -p /app/backend /app/backend/node_modules/@drawoff /var/lib/drawoff \
  && tar -xzf /tmp/backend.tgz --strip-components=1 -C /app/backend \
  && mkdir -p /app/backend/node_modules/better-sqlite3/build/Release \
  && mv /tmp/better_sqlite3.node /app/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && ln -s /app/packages/contracts /app/backend/node_modules/@drawoff/contracts \
  && rm /tmp/backend.tgz \
  && chown -R node:node /app/backend /app/packages /var/lib/drawoff

WORKDIR /app/backend
USER node
EXPOSE 3000
VOLUME ["/var/lib/drawoff"]
CMD ["node", "dist/index.js"]
