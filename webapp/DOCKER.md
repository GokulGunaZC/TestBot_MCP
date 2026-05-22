# Healix Webapp — Docker Distribution Guide

This document explains how to **build** the production Docker image (you, the
maintainer) and how to **ship & run** it (the client). The image bundles a
compiled Next.js standalone server — **no TypeScript source is shipped**.

> **TL;DR for the client**
> ```bash
> docker load -i healix-webapp-<version>.tar
> cp .env.docker.example .env.docker     # fill in secrets
> docker compose --profile migrate run --rm migrate    # one-time DB init
> docker compose up -d
> open http://localhost:3000
> ```

---

## 1. What's in the image (and what isn't)

**Included** (final runner stage, ~200 MB):

- `webapp/server.js` — compiled Next.js standalone entrypoint (minified JS).
- `webapp/.next/static` — hashed static assets.
- `webapp/public` — public files (favicon, etc.).
- `webapp/drizzle/*.sql` — DB migration files.
- `webapp/docker/migrate.mjs` — idempotent migration runner.
- Minimal `node_modules` (only what `server.js` actually imports — tree-shaken
  by Next.js's output tracing).
- Non-root `nextjs` user.

**NOT included** — these never reach the client:

- `src/**` TypeScript source.
- `tests/`, `healix-reports/`, `scripts/` dev scripts.
- `.env*` files.
- `.git/`, `.github/`, IDE configs.
- Browser source maps (`productionBrowserSourceMaps: false`).
- Full `node_modules` (only the production-required subset is bundled).

---

## 2. Files created in the repo

| File | Purpose |
|---|---|
| `webapp/Dockerfile` | Multi-stage build (deps → builder → runner) |
| `webapp/Dockerfile.dockerignore` | Context filter used by BuildKit when `-f webapp/Dockerfile` |
| `webapp/docker/entrypoint.sh` | Container entrypoint (env validation + optional migrations) |
| `webapp/docker/migrate.mjs` | Idempotent SQL migration runner (uses `public._drizzle_docker_migrations`) |
| `webapp/docker-compose.yml` | One-command spin-up guide for the client |
| `webapp/.env.docker.example` | Runtime env template to send to the client |
| `webapp/DOCKER.md` | This file |

## 3. One-time prerequisites (maintainer)

```bash
# Linux / WSL2 / macOS
docker --version           # >= 24.x
docker buildx version      # multi-arch builds (optional but recommended)
```

If you want to ship a multi-arch image (Apple Silicon + Linux servers):

```bash
docker buildx create --use --name healix-builder
```

---

## 4. Build the image (maintainer)

Run from the **monorepo root** — the build context must include both the
`webapp/` and the workspace `package-lock.json`.

```bash
VERSION=1.0.0

docker build \
  --file webapp/Dockerfile \
  --tag healix-webapp:${VERSION} \
  --tag healix-webapp:latest \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="https://<your-project>.supabase.co" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="<your-anon-key>" \
  --build-arg NEXT_PUBLIC_APP_URL="https://app.example.com" \
  .
```

Multi-arch (linux/amd64 + linux/arm64):

```bash
docker buildx build \
  --file webapp/Dockerfile \
  --platform linux/amd64,linux/arm64 \
  --tag healix-webapp:${VERSION} \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="https://<your-project>.supabase.co" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="<your-anon-key>" \
  --build-arg NEXT_PUBLIC_APP_URL="https://app.example.com" \
  --output type=docker \
  .
```

### Verify the image locally before shipping

```bash
# Sanity-check: confirm no .ts source files leaked.
docker run --rm healix-webapp:${VERSION} sh -c 'find /app -name "*.ts" -not -path "*/node_modules/*"'
# Expected output: (nothing)

# Confirm size.
docker images healix-webapp:${VERSION}

# Smoke test with a dummy DB (image will boot then fail health check — fine).
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgresql://test:test@localhost:5432/test" \
  -e SUPABASE_SERVICE_ROLE_KEY="dummy" \
  -e OPENAI_API_KEY="dummy" \
  healix-webapp:${VERSION}
```

---

## 5. Ship the image to the client

Pick **one** of the three transports below.

### Option A — Private container registry (recommended)

Push once, client pulls. Works well for Docker Hub, GitHub Container Registry,
AWS ECR, etc.

**You:**

```bash
docker tag healix-webapp:1.0.0 ghcr.io/<your-org>/healix-webapp:1.0.0
docker push       ghcr.io/<your-org>/healix-webapp:1.0.0
```

Grant the client read-only access to the repository (e.g. GitHub PAT with
`read:packages`).

**Client:**

```bash
echo "<token>" | docker login ghcr.io -u <client-username> --password-stdin
docker pull ghcr.io/<your-org>/healix-webapp:1.0.0
```

### Option B — Offline tarball (`docker save`)

Best when the client cannot reach an external registry.

**You:**

```bash
docker save healix-webapp:1.0.0 | gzip > healix-webapp-1.0.0.tar.gz
sha256sum healix-webapp-1.0.0.tar.gz > healix-webapp-1.0.0.tar.gz.sha256
```

Send the `.tar.gz` and the `.sha256` over your delivery channel.

**Client:**

```bash
sha256sum -c healix-webapp-1.0.0.tar.gz.sha256
gunzip -c healix-webapp-1.0.0.tar.gz | docker load
# Output: Loaded image: healix-webapp:1.0.0
```

### Option C — Encrypted tarball over object storage

Same as B but wrapped in `age` / `gpg` and uploaded to S3 / GCS. Useful when
sending across organisations with no shared registry.

---

## 6. Run the image (client)

### 6.1 Prerequisites on the client machine

- Docker 24+ (`docker --version`)
- Docker Compose v2 (`docker compose version`)
- Outbound HTTPS to Supabase, OpenAI, Stripe (whatever you provisioned).

### 6.2 Files the client needs (alongside the image)

The maintainer should send these files together with the image:

```
healix-webapp-1.0.0.tar.gz   ← the image
docker-compose.yml           ← committed in the repo, copy-paste-able
.env.docker.example          ← template; client fills it in
DOCKER.md                    ← this file
```

### 6.3 Configure runtime secrets

```bash
cp .env.docker.example .env.docker
# Open .env.docker in an editor and fill in:
#   DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
#   STRIPE_* (if billing enabled), and anything else marked REQUIRED.
chmod 600 .env.docker   # tighten perms — file contains secrets
```

### 6.4 One-time database initialisation

The image ships with all Drizzle migration SQL files. Run them **once**
against the target database:

```bash
docker compose --profile migrate run --rm migrate
```

Expected tail:

```
[migrate] ✓ done — N new migration(s) applied, 0 already present
```

The runner is idempotent — re-running it after deployment skips migrations
already recorded in `public._drizzle_docker_migrations`.

### 6.5 Start the webapp

```bash
docker compose up -d
docker compose logs -f webapp        # tail logs
```

Then open `http://localhost:3000` (or whichever port you set via `PORT`).

### 6.6 Stop / restart / remove

```bash
docker compose restart webapp
docker compose stop
docker compose down                  # removes the container; image stays
docker compose down --rmi all        # also removes the image
```

---

## 7. Upgrading to a new version

**Client receives `healix-webapp-1.1.0.tar.gz`:**

```bash
docker load -i healix-webapp-1.1.0.tar.gz
export WEBAPP_IMAGE=healix-webapp:1.1.0
docker compose --profile migrate run --rm migrate   # apply any new SQL
docker compose up -d                                # rolling restart
```

Old image stays cached. Remove with `docker image prune -a`.

---

## 8. Operational tips

- **Logs** are written to stdout/stderr — collect them with your preferred
  log driver: `docker compose up -d --log-driver=json-file --log-opt max-size=50m`
  or wire up Loki/Datadog at the daemon level.
- **Reverse proxy / TLS** — terminate TLS in front (nginx, Caddy, Traefik,
  cloudflared). The container exposes plain HTTP on port 3000.
- **Resource limits** — add to `docker-compose.yml`:
  ```yaml
  deploy:
    resources:
      limits:
        memory: 1.5G
        cpus: "1.0"
  ```
- **Healthcheck** — built into the image. `docker ps` shows the status; use
  `docker inspect --format '{{.State.Health.Status}}' healix-webapp` to query.
- **Read-only root filesystem** — for extra hardening:
  ```yaml
  read_only: true
  tmpfs: [/tmp]
  ```

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `✗ Missing required environment variables: DATABASE_URL ...` | `.env.docker` not loaded or var typo. | Verify `docker compose config` shows the var set; re-check filename. |
| `auth/v1 returned 401` in browser console | `NEXT_PUBLIC_SUPABASE_*` baked at build time doesn't match the project the service role key belongs to. | Rebuild with matching `--build-arg` values. |
| `ECONNREFUSED` to Supabase | Container can't reach the database from the host network. | Ensure outbound 443/6543 open; if Supabase IP-restricted, allowlist the host. |
| Container restarts every minute | Healthcheck failing — server not booting. | `docker compose logs webapp` — usually a missing env var or DB unreachable. |
| `Error: Cannot find module '...'` on boot | Standalone trace missed a dynamic import. | Add the missing module to `serverExternalPackages` in `next.config.ts` and rebuild. |
| Migrations fail with `permission denied for schema public` | DB role lacks DDL rights. | Run migrations as the postgres owner role once. |

---

## 10. Security notes

- The image runs as **non-root** (`nextjs` UID 1001).
- Server-side secrets are **never baked** into the image — they live only in
  `.env.docker` on the client machine. Anyone with `docker inspect` access on
  that host can still read them; restrict host access accordingly.
- `NEXT_PUBLIC_*` values are public by design (they reach the browser); they
  are baked at build time and visible in the JS bundle.
- Browser source maps are disabled; the minified bundle is the only client-side
  artefact.
- The image does **not** contain SSH, package managers beyond what node-alpine
  ships, or the build toolchain. Lateral-movement surface is minimal.
