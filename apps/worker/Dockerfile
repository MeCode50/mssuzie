# syntax=docker/dockerfile:1.7
# MsSuzie worker: the queue loop that runs the agents. Build from the REPO ROOT:
#   docker build -f apps/worker/Dockerfile -t mssuzie-worker .
# No .env is baked in; every setting arrives as an environment variable at run time.

# Base image pinned by digest (a tag can change under you). Refresh it now and then to pick up security patches:
#   docker buildx imagetools inspect node:22-alpine   (use the top-level Digest)
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Keep in step with "packageManager" in package.json. Fetched once here, not in every stage.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# 1. Dependencies (and the generated Prisma client).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/core/prisma packages/core/prisma
COPY packages/core/prisma.config.ts packages/core/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@mssuzie/worker..."

# 2. Bundle the worker (and the shared core package) into one file. The runtime image then needs no node_modules,
#    no TypeScript runner and none of the build tools.
FROM deps AS build
COPY apps/worker apps/worker
COPY packages/core packages/core
COPY tsconfig.base.json ./
RUN pnpm --filter @mssuzie/worker build

# 3. Runtime: non-root, tiny.
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production WORKER_HEALTH_PORT=8081
LABEL org.opencontainers.image.title="mssuzie-worker" \
      org.opencontainers.image.description="MsSuzie scheduling worker (runs the agents)" \
      org.opencontainers.image.source="https://github.com/MeCode50/mssuzie"
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
WORKDIR /app
COPY --from=build --chown=app:app /repo/apps/worker/dist ./
USER app
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health >/dev/null || exit 1
# node is PID 1 and handles SIGTERM itself: it stops claiming, lets running jobs finish (up to
# WORKER_SHUTDOWN_GRACE_MS) and hands unfinished ones back to the queue.
CMD ["node", "--enable-source-maps", "index.mjs"]
