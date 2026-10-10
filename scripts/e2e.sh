#!/usr/bin/env bash
# Browser tests (Playwright) against a throwaway database, the scripted stand-in model, a fake calendar and
# dry-run email. Needs podman or docker (the same test Postgres as `pnpm test:db`). Never touches Neon,
# Google or SMTP. Usage: scripts/e2e.sh [playwright args]   e.g.  scripts/e2e.sh --headed -g "happy"
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/test-db.sh up
BASE="$(bash scripts/test-db.sh url)"
URL="${BASE%/*}/mssuzie_e2e"

(cd packages/core && node -e '
  const { Client } = require("pg");
  (async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
    await c.query("DROP DATABASE IF EXISTS mssuzie_e2e WITH (FORCE)"); await c.query("CREATE DATABASE mssuzie_e2e"); await c.end(); })();' "${BASE%/*}/postgres")

export NODE_ENV=development DATABASE_URL="$URL" DIRECT_URL="$URL" MOCK_LLM=1 EMAIL_DRY_RUN=1
export EMAIL_ALLOWLIST=demo@example.com DEMO_INBOX=demo@example.com
export ENCRYPTION_KEY="$(head -c32 /dev/urandom | base64)"
export BETTER_AUTH_SECRET="$(head -c48 /dev/urandom | base64)" BETTER_AUTH_URL=http://localhost:3100
export ACTION_LINK_SECRET="$(head -c48 /dev/urandom | base64)" LLM_API_KEY=x LLM_MODEL_MAIN=mock LLM_MODEL_SMALL=mock
export SEED_EBUN_EMAIL=ebun@example.com SEED_EBUN_PASSWORD=e2e-password-1
export SEED_OPS2_NAME="Ops Two" SEED_OPS2_EMAIL=ops2@example.com SEED_OPS2_PASSWORD=e2e-password-1
export SEED_TUTOR1_NAME="Daniel Reyes" SEED_TUTOR1_EMAIL=daniel@example.com SEED_TUTOR1_PASSWORD=e2e-password-1
export SEED_TUTOR2_NAME="Sophie Lindqvist" SEED_TUTOR2_EMAIL=sophie@example.com SEED_TUTOR2_PASSWORD=e2e-password-1
export E2E_PASSWORD=e2e-password-1 NEXT_DIST_DIR=.next-e2e

pnpm --filter @mssuzie/core exec prisma migrate deploy >/dev/null
pnpm db:seed >/dev/null
cd apps/web && exec pnpm exec playwright test "$@"
