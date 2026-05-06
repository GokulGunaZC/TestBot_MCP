# Phase 2: Async generation rollout

**Goal**: enable `HEALIX_GEN_ASYNC=true` in production without breaking existing customers.

## Pre-flight

- [ ] Inngest account created; organization linked to Vercel via the Inngest Vercel integration.
- [ ] `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` set on production and preview Vercel environments.
- [ ] DB migration `webapp/drizzle/0007_generation_jobs.sql` applied to production Postgres.
- [ ] DB migration `webapp/drizzle/0008_generation_plans.sql` applied to production Postgres (from P1.5 — prerequisite for planner cache).
- [ ] `@healix/mcp@2.1.0` published to npm (contains `generateTestsAsync`, `pollGenerationJob`, and the async branch in `maybeGenerateViaSaaS`).
- [ ] Health-check `GET /api/inngest` returns 200 with function registry JSON listing `generate-tests-orchestrator` + `generate-tests-agent`.

## Rollout order (CRITICAL — do not reorder)

1. **Deploy webapp WITHOUT the flag** → `HEALIX_GEN_ASYNC=false`.
   - Verifies the new routes (`/api/inngest`, `/api/generate-tests/jobs/[jobId]`, `/api/generate-tests/plan`) compile and respond to health checks.
   - Old MCPs continue using the sync path unchanged.
   - Monitor: Vercel access logs for `/api/inngest` should show Inngest health-check hits.
2. **Bump MCP to 2.1** → `generateTestsAsync` + `pollGenerationJob` ship.
   - Old webapps that don't support async return 200 (not 202) → MCP falls through to sync. Zero breakage.
   - New webapp with `HEALIX_GEN_ASYNC=false` still returns 200 → MCP still sync. Still zero breakage.
3. **Canary flip — one test account**:
   - Set `profile.settings.gen_async_enabled = true` for a single internal test user.
   - Run 5 suites from that account in Cursor. Verify:
     - Vercel logs show 202 responses from `/api/generate-tests`.
     - Inngest dashboard shows 6 function runs per job (1 orchestrator + 5 agents).
     - MCP stderr shows `generation_async_progress` status ticks.
     - Dashboard renders the live `GenerationJobProgressChip` advancing 0/5 → 5/5.
     - Final dashboard shows full test results, no partial banner.
4. **Per-user rollout** — add 5 more early-access users via the same per-user override. Watch for 3 days.
5. **Global flag flip** — set `HEALIX_GEN_ASYNC=true` in Vercel prod env. Monitor for 48h.

## Rollback

- **Instant**: set `HEALIX_GEN_ASYNC=false` on Vercel. Env flip takes effect on next request.
- In-flight async jobs: **Inngest persists them**. They continue to run and write to the job row. Poll endpoint still responds. No users are orphaned.
- If MCP hangs mid-poll because the webapp flipped: the poll has a ceiling of `min(stage budget, HEALIX_GEN_BUDGET_MS)`. Worst case a user waits up to 15 min before the run errors cleanly via the rescue path.

## Abuse / failure drills

- [ ] Set `INNGEST_SIGNING_KEY` to garbage → webhook handler rejects → `inngest.send` from `/api/generate-tests` rejects → fallback to sync path fires. User still gets tests.
- [ ] Kill the Vercel preview mid-poll (force redeploy) → MCP's `pollGenerationJob` retries up to 5 times with 2s backoff → recovers on redeploy. Otherwise surfaces `WEBAPP_UNREACHABLE`.
- [ ] Fire 3 simultaneous MCP runs from 3 different API keys → Inngest's global concurrency cap (20) + per-jobId cap (5) isolate them. Confirm via Inngest UI.
- [ ] Exceed per-user concurrent job cap (3) → 4th request returns `429 TOO_MANY_CONCURRENT_JOBS`. MCP surfaces this via remediation block.
- [ ] Revoke API key mid-poll → next poll returns 401 → MCP rejects with `INVALID_API_KEY` immediately, no retry storm.

## Cost model

- Inngest free tier: **25k function runs/month**.
- Per generation job: 1 orchestrator + 5 agent invocations = **6 runs**.
- At **100 jobs/day** → ~18k runs/month. Fits free tier with ~28% headroom.
- Upgrade trigger: sustained **>400 jobs/day** (95k runs/month) → move to Inngest Pro.

## Feature-flag matrix

| `HEALIX_GEN_ASYNC` | `x-healix-async` header / `body.async` | `profile.settings.gen_async_enabled` | Behavior |
|---|---|---|---|
| false (default) | any | any | Sync Phase-1 per-agent fan-out |
| true | absent | false | Sync Phase-1 (header opt-in required) |
| true | `1` / `true` | any | **Async enqueue → 202 + poll** |
| false | `1` / `true` | `true` | **Async enqueue** (per-user override wins) |
| true | any | any | If `inngest.send` fails → fallback to sync |

## Monitoring

- **Inngest dashboard** — function success rate per day, median duration per function, retry counts.
- **Postgres** — daily job outcome counts:
  ```sql
  SELECT status, COUNT(*)
  FROM generation_jobs
  WHERE created_at > now() - interval '1 day'
  GROUP BY status;
  ```
  Alert on `failed > 5%` of total.
- **Vercel logs** — 202s on `/api/generate-tests`, 200/304 mix on `/api/generate-tests/jobs/:id` (304s should dominate on long jobs thanks to ETag).
- **MCP stderr** — presence of `generation_async_progress` ticks. Absence = stuck poll → investigate Inngest function logs for that jobId.

## Related env vars

| Var | Scope | Role |
|---|---|---|
| `HEALIX_GEN_ASYNC` | webapp | Global async-mode gate |
| `HEALIX_GEN_BUDGET_MS` | MCP | Caps generation stage wall-clock (also caps async poll loop) |
| `HEALIX_SKIP_PLANNER` | MCP | Emergency bypass for the planner pre-pass |
| `INNGEST_EVENT_KEY` | webapp | Inngest event ingestion key |
| `INNGEST_SIGNING_KEY` | webapp | Inngest webhook signature verification |
| `INNGEST_DEV` | webapp | Local-only; set to `1` for `inngest-cli dev` |
