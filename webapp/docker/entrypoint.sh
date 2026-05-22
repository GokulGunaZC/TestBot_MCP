#!/bin/sh
# =============================================================================
# Container entrypoint.
#
# Responsibilities:
#   1. Fail fast if required runtime env vars are missing.
#   2. Optionally apply pending Drizzle migrations (RUN_MIGRATIONS=true).
#   3. Exec the Next.js standalone server (passed as CMD).
#
# Why a shell script and not direct node?
#   • Lets the client toggle migrations with a single env var.
#   • Surfaces config errors before the Next server tries (and fails) to boot.
# =============================================================================
set -eu

REQUIRED_VARS="DATABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY"
missing=""
for v in $REQUIRED_VARS; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    missing="$missing $v"
  fi
done

if [ -n "$missing" ]; then
  echo "" >&2
  echo "✗ Missing required environment variables:$missing" >&2
  echo "  Set them in your --env-file or via -e flags." >&2
  echo "  See .env.docker.example for the full list." >&2
  echo "" >&2
  exit 1
fi

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "→ RUN_MIGRATIONS=true — applying Drizzle migrations..."
  node /app/webapp/docker/migrate.mjs
  echo "✓ Migrations complete."
fi

echo "→ Starting Next.js server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec "$@"
