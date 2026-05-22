#!/bin/bash
# =============================================================================
# One-command Docker build + run script.
#
# Usage:
#   ./webapp/docker/build.sh              # Build only
#   ./webapp/docker/build.sh --run        # Build + run
#   ./webapp/docker/build.sh --run --migrate  # Build + migrate + run
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBAPP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$WEBAPP_DIR")"
ENV_FILE="$WEBAPP_DIR/.env.local"
IMAGE_NAME="healix-webapp"
IMAGE_TAG="1.0.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check .env.local exists
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}✗ $ENV_FILE not found${NC}"
  echo "  Copy .env.example to .env.local and fill in your values first."
  exit 1
fi

# Load NEXT_PUBLIC_* vars from .env.local
load_env_var() {
  grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

NEXT_PUBLIC_SUPABASE_URL=$(load_env_var "NEXT_PUBLIC_SUPABASE_URL")
NEXT_PUBLIC_SUPABASE_ANON_KEY=$(load_env_var "NEXT_PUBLIC_SUPABASE_ANON_KEY")
NEXT_PUBLIC_APP_URL=$(load_env_var "NEXT_PUBLIC_APP_URL")

# Validate required build-time vars
if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ]; then
  echo -e "${RED}✗ Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local${NC}"
  exit 1
fi

# Default APP_URL if not set
NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-http://localhost:3000}"

echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Building $IMAGE_NAME:$IMAGE_TAG${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "  NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL:0:40}..."
echo "  NEXT_PUBLIC_APP_URL:      $NEXT_PUBLIC_APP_URL"
echo ""

cd "$REPO_ROOT"

docker build \
  --file webapp/Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  --build-arg NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" \
  --tag "$IMAGE_NAME:$IMAGE_TAG" \
  --tag "$IMAGE_NAME:latest" \
  .

echo ""
echo -e "${GREEN}✓ Build complete: $IMAGE_NAME:$IMAGE_TAG${NC}"

# Handle --run flag
if [[ "$*" == *"--run"* ]]; then
  echo ""
  
  # Handle --migrate flag
  if [[ "$*" == *"--migrate"* ]]; then
    echo -e "${YELLOW}→ Running database migrations...${NC}"
    docker run --rm \
      --env-file "$ENV_FILE" \
      "$IMAGE_NAME:$IMAGE_TAG" \
      node /app/webapp/docker/migrate.mjs
    echo -e "${GREEN}✓ Migrations complete${NC}"
    echo ""
  fi

  echo -e "${YELLOW}→ Starting container on http://localhost:3000${NC}"
  docker run --rm -p 3000:3000 \
    --env-file "$ENV_FILE" \
    --name healix-webapp \
    "$IMAGE_NAME:$IMAGE_TAG"
fi
