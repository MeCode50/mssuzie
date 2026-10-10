# syntax=docker/dockerfile:1.7
# MsSuzie web app: Next.js standalone server. Build from the REPO ROOT:
#   docker build -f apps/web/Dockerfile -t mssuzie-web .
# No .env is baked in; every setting arrives as an environment variable at run time.

# Base image pinned by digest (a tag can change under you). Refresh it now and then to pick up security patches:
#   docker buildx imagetools inspect node:22-alpine   (use the top-level Digest)
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# Keep in step with "packageManager" in package.json. Fetched once here, not in every stage.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# 1. Dependencies (cached until a package.json, the lockfile or the Prisma schema changes).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
# core's postinstall runs `prisma generate`, so the schema and config must be there before the install.
COPY packages/core/prisma packages/core/prisma
COPY packages/core/prisma.config.ts packages/core/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@mssuzie/web..."

# 2. Build.
FROM deps AS build
COPY apps/web apps/web
COPY packages/core packages/core
COPY tsconfig.base.json ./
RUN pnpm --filter @mssuzie/web build

# 3. Runtime: only the standalone server, as a non-root user.
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
LABEL org.opencontainers.image.title="mssuzie-web" \
      org.opencontainers.image.description="MsSuzie scheduling web app" \
      org.opencontainers.image.source="https://github.com/MeCode50/mssuzie"
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
WORKDIR /app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
