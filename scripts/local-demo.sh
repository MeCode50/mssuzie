#!/usr/bin/env bash
# Local, throwaway demo: own Postgres database + mock LLM + in-memory calendar + dry-run email.
# Touches nothing external (not Neon, not Google, not SMTP).
#   scripts/local-demo.sh setup   create + migrate + seed the database (safe to repeat: it reseeds)
#   scripts/local-demo.sh web     start the web app on http://localhost:3000
#   scripts/local-demo.sh worker  start the worker (in a second terminal)
#   scripts/local-demo.sh env     print the environment, for your own shell
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/test-db.sh up
BASE="$(bash scripts/test-db.sh url)"
URL="${BASE%/*}/mssuzie_demo"
KEYFILE=".local-demo-key"   # git-ignored via .env* rules? keep it out of git explicitly below
grep -qx "$KEYFILE" .gitignore || echo "$KEYFILE" >> .gitignore
[ -s "$KEYFILE" ] || head -c32 /dev/urandom | base64 > "$KEYFILE"
KEY="$(cat "$KEYFILE")"

export DATABASE_URL="$URL" DIRECT_URL="$URL" MOCK_LLM=1 EMAIL_DRY_RUN=1
export EMAIL_ALLOWLIST=demo@example.com DEMO_INBOX=demo@example.com
export ENCRYPTION_KEY="$KEY" BETTER_AUTH_SECRET="$KEY$KEY" BETTER_AUTH_URL=http://localhost:3000
export ACTION_LINK_SECRET="$KEY$KEY" LLM_API_KEY=x LLM_MODEL_MAIN=mock LLM_MODEL_SMALL=mock
export SEED_EBUN_EMAIL=ebun@example.com SEED_EBUN_PASSWORD=demo-password-1
export SEED_OPS2_NAME="Ops Two" SEED_OPS2_EMAIL=ops2@example.com SEED_OPS2_PASSWORD=demo-password-1
export SEED_TUTOR1_NAME="Daniel Reyes" SEED_TUTOR1_EMAIL=daniel@example.com SEED_TUTOR1_PASSWORD=demo-password-1
export SEED_TUTOR2_NAME="Sophie Lindqvist" SEED_TUTOR2_EMAIL=sophie@example.com SEED_TUTOR2_PASSWORD=demo-password-1

case "${1:-}" in
  setup)
    node -e '
      const { Client } = require("pg");
      (async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
        const r = await c.query("select 1 from pg_database where datname = $1", ["mssuzie_demo"]);
        if (!r.rowCount) await c.query("CREATE DATABASE mssuzie_demo"); await c.end(); })();' "${BASE%/*}/postgres" 2>/dev/null \
      || (cd packages/core && node -e '
      const { Client } = require("pg");
      (async () => { const c = new Client({ connectionString: process.argv[1] }); await c.connect();
        const r = await c.query("select 1 from pg_database where datname = $1", ["mssuzie_demo"]);
        if (!r.rowCount) await c.query("CREATE DATABASE mssuzie_demo"); await c.end(); })();' "${BASE%/*}/postgres")
    pnpm --filter @mssuzie/core exec prisma migrate deploy
    pnpm db:seed
    echo; echo "Ready. Sign in with ebun@example.com / demo-password-1 (ops) at http://localhost:3000"
    echo "Now run:  scripts/local-demo.sh web     and in a 2nd terminal:  scripts/local-demo.sh worker" ;;
  web)    exec pnpm --filter @mssuzie/web dev ;;
  worker) exec pnpm worker ;;
  env)    env | grep -E '^(DATABASE_URL|DIRECT_URL|MOCK_LLM|DEMO_INBOX|EMAIL_|ENCRYPTION_KEY|BETTER_AUTH|ACTION_LINK|LLM_|SEED_)' | sed 's/^/export /' ;;
  *) echo "usage: $0 setup|web|worker|env" >&2; exit 2 ;;
esac
