#!/usr/bin/env bash
# Throwaway Postgres for the DB-backed tests (queue concurrency, executeRun, worker).
# Usage: scripts/test-db.sh up | down | url      (uses podman, falls back to docker)
set -euo pipefail

NAME=mssuzie-test-pg
PORT=54329
URL="postgresql://postgres:test@localhost:${PORT}/mssuzie_test"
ENGINE="$(command -v podman || command -v docker || true)"

case "${1:-}" in
  url) echo "$URL" ;;
  up)
    [ -n "$ENGINE" ] || { echo "Need podman or docker for the test database" >&2; exit 1; }
    if ! "$ENGINE" ps --format '{{.Names}}' | grep -qx "$NAME"; then
      "$ENGINE" run -d --rm --name "$NAME" -p "${PORT}:5432" \
        -e POSTGRES_PASSWORD=test -e POSTGRES_DB=mssuzie_test docker.io/library/postgres:17-alpine >/dev/null
    fi
    for _ in $(seq 1 60); do
      "$ENGINE" exec "$NAME" pg_isready -U postgres -d mssuzie_test >/dev/null 2>&1 && exit 0
      sleep 0.5
    done
    echo "test database did not become ready" >&2; exit 1 ;;
  down) [ -n "$ENGINE" ] && "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|down|url" >&2; exit 2 ;;
esac
