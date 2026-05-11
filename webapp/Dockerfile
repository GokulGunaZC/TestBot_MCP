# syntax=docker/dockerfile:1.7
# =============================================================================
# Healix Webapp — production Docker image
#
# Goals:
#   • Ship to clients without exposing TypeScript source / business logic.
#   • Single self-contained binary (Next.js standalone output) + static assets.
#   • Small final image (~200 MB) using node:20-alpine.
#   • Reproducible builds; runtime configuration via env vars only.
#
# Build:
#   docker build \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJh... \
#     --build-arg NEXT_PUBLIC_APP_URL=https://app.example.com \
#     -t healix-webapp:1.0.0 \
#     -f webapp/Dockerfile .                  # build context = monorepo root
# (BuildKit uses webapp/Dockerfile.dockerignore for context filtering)
#
# Run:
#   docker run --rm -p 3000:3000 --env-file webapp/.env.docker healix-webapp:1.0.0
# =============================================================================

ARG NODE_VERSION=20.18-alpine

# -----------------------------------------------------------------------------
# Stage 1: deps — install production + dev deps (dev needed to build).
# Cached unless package*.json changes.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /workspace

# libc6-compat: required by some native modules (e.g. sharp, postgres) on alpine.
RUN apk add --no-cache libc6-compat

# Copy the monorepo lockfile + workspace manifests only.
# This makes the deps layer cache hit unless dependencies actually change.
COPY package.json package-lock.json* ./
COPY webapp/package.json ./webapp/
COPY testbot-mcp/package.json ./testbot-mcp/

# npm ci respects the lockfile and is faster + reproducible.
# --include=dev because the builder stage needs next, typescript, tailwind, etc.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2: builder — compile Next.js to standalone output.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /workspace

# Build-time only env vars. NEXT_PUBLIC_* are baked into the client bundle.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL

ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Reuse the dependency tree from stage 1.
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/webapp/node_modules ./webapp/node_modules

# Copy the rest of the source. .dockerignore strips secrets and bulky dirs.
COPY . .

# Fail loudly if required public env vars are missing — otherwise the bundle
# would silently embed `undefined` and break auth at runtime.
RUN if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ]; then \
      echo "ERROR: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be supplied as --build-arg" >&2; \
      exit 1; \
    fi

# Build only the webapp workspace.
RUN npm run build --workspace=webapp

# -----------------------------------------------------------------------------
# Stage 3: runner — final, minimal, non-root image.
# Contains ONLY: compiled standalone server, static assets, public/, drizzle
# migration SQL files, and the migration runner script. No TypeScript source.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user — Next.js best practice.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone output bundles the minimum node_modules + a Next server entrypoint.
# Tree-structure inside .next/standalone matches the monorepo, so we copy the
# whole thing to /app preserving paths.
COPY --from=builder --chown=nextjs:nodejs /workspace/webapp/.next/standalone ./
# Static assets and public files are NOT included in standalone; copy separately.
COPY --from=builder --chown=nextjs:nodejs /workspace/webapp/.next/static ./webapp/.next/static
COPY --from=builder --chown=nextjs:nodejs /workspace/webapp/public ./webapp/public

# Drizzle migration SQL + minimal runner (so the client can init their DB).
COPY --from=builder --chown=nextjs:nodejs /workspace/webapp/drizzle ./webapp/drizzle
COPY --chown=nextjs:nodejs webapp/docker/migrate.mjs ./webapp/docker/migrate.mjs
COPY --chown=nextjs:nodejs webapp/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER nextjs
EXPOSE 3000

# Healthcheck — node is guaranteed; avoid any optional alpine tool dependency.
# Treats HTTP 2xx/3xx as healthy, 5xx or connection error as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',(r)=>process.exit(r.statusCode>=500?1:0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# server.js is the Next.js standalone entrypoint, generated at build time.
CMD ["node", "webapp/server.js"]
