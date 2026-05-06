# Healix v1 — Shipped State (as of 2026-04-18)

Snapshot of what the `resilient-popping-marshmallow` plan delivered, what's live, and what's still open. Use this before planning the failure-triage epic (next doc: `HEALIX_V1_TRIAGE_PLAN.md`).

## Shipped (all Phase tasks #1–#8 + #10–#13 complete)

### Phase 0 — Cleanup & rebrand
- Deleted dead AI providers (`sarvam.js`, `cascade.js`, `windsurf.js`, `openai.js` under `ai-providers/`).
- Deleted orphan files: `restart-mcp.ps1`, `ARTIFACT_STORAGE_SETUP.md`, `WINDOWS_CONFIG_UI_FIX.md`.
- Rebranded every user-facing `testbot` → `healix` (README, config UI, fixture names, URL parsers).
- Fixed silent failures: `context-gatherer.js` missing helpers, `index.js:906` continuing past failed key validation, `index.js:1395` swallow-all catch, PRD-read silent drop, config-UI port-retry infinite loop.
- Merged duplicated HTTP-server plumbing into `local-http-server.js`.

### Phase A — Thin-client MCP
- `pipeline-worker.js:1632` — all testTypes route through `/api/generate-tests`. No more `testType === 'backend'` branch.
- `test-generator-openai.js` → `test-generator-client.js`. Local OpenAI removed; only validation helpers kept.
- `src/webapp-client.js` — one client for all webapp endpoints, `x-api-key: HEALIX_API_KEY`.
- Only two user-visible env vars: `HEALIX_API_KEY` (required), `HEALIX_DASHBOARD_URL` (optional).

### Phase B — PRD parser + AC-traced generation
- `/api/parse-prd` with SHA-256 caching by PRD hash.
- `ParsedPRD` schema (features → userStories → acceptanceCriteria with `authRequired`, `roleHint`, `kind`).
- Every generated test titled `[REQ:F#.S#.AC#]`; body rejected if zero `expect(...)` calls.

### Phase C — Browser-use exploration
- `browser-use-driver.js` with auto-install consent (pipx → venv fallback).
- `scripts/browser_use_runner.py` emits `ExplorationArtifact` (routes, forms, authFlow, keyFlows).
- `/api/exploration/plan` ranks flows, suggests AC.
- Skip-browser-use opt-out in config UI.

### Phase D — Role-based credential injection
- `credentials-injector.js` builds `storageState` per role into `.healix/auth-state-{role}.json`.
- Playwright projects split: `tierA-public`, `tierB-auth-{role}`, `tierC-backend`.
- `results-merger.js` adds distinct `blocked` status.
- Auth-retry flow: login fails once → config UI re-opens with reason → retry once → `blocked` on second fail (A+C still run).
- Drizzle migration `0004_tier_results.sql`; `tier_results jsonb` on `test_runs`.
- Dashboard tier pills with passed/failed/blocked.
- `artifact-uploader.js` deny-list blocks `.healix/auth-state-*.json`.

### Phase E — Exploration-enriched generation
- When `parsedPRD.acCount < 3`, `openai-generator.ts` promotes `keyFlows` to primary prompt input.
- `/api/exploration/plan` returns `suggestedAcceptanceCriteria` — dashboard renders as "AI-inferred AC (review me)".

### Phase F — Vercel deploy readiness
- `/api/artifacts` — local fs fallback removed; Supabase Storage only.
- `next.config.ts` body limits dropped to 25 MB; signed upload URLs for large artifacts.
- `engines.node: >=18.0.0` added to `webapp/package.json`.
- Root `.env.example` as single source of truth.
- Root `vercel.json` with per-route `maxDuration` (AI endpoints 180–300s after today's fix).
- `0003` migration collision fixed (renamed).
- `.github/workflows/ci.yml` + `deploy.yml`.

### Phase G — npm publish
- `@healix/mcp@2.0.0` published (breaking: drops `OPENAI_API_KEY` as user-facing).
- `bin/healix-mcp.js` rewritten — it was a bare `require` that never started the server under Cursor's stdio. Now directly instantiates and calls `server.start()`.
- `MIGRATION.md` shipped.
- `npm pack` audited; only `bin/`, `src/`, `dashboard/`, `scripts/` ship.

### Phases #10–#13 — Late additions
- Monorepo port discovery in MCP parse-prd call + PRD-less fallback path.
- API-only repo detection → deep multi-step backend flow testing when no frontend exists.
- `openai-generator` refactored into `agents/*` + dispatcher + planner.
- Durable pipeline state (`agent_events` table) + stage budgets + env cleanup.

## Fixes landed today (2026-04-18)

- **Agent retry loop** (`index.js`): `handleTestMyApp` now short-circuits on recent run state. If the last run errored <10 min ago, the tool returns an `isError` response telling the agent "DO NOT retry blindly — fix the root cause in code". `force: true` is the escape hatch. Before the fix, every retry re-opened the config UI, forcing the user to re-enter the same settings.
- **`bin/healix-mcp.js` handshake**: the wrapper was `require('../src/index.js')` but the server only started under `require.main === module`, which fires only for the entry file. Fixed.
- **`~/.cursor/mcp.json` trailing comma**: user's healix-mcp entry had an extra comma — Cursor silently ignored the block.
- **Supabase schema drift**: `0004` hadn't been applied (Drizzle journal out of sync with baseline). Applied `ALTER TABLE` directly for `current_phase`, `current_phase_at`, `tier_results`, `agent`, `latency_ms`.
- **Playwright error-message extraction** (`playwright-integration.js`): was collapsing multi-line stderr into a useless one-line noise blob. Now prefers `Error:`/`SyntaxError:`/`failed to start` pattern lines, falls back to last 8 lines, and writes the full stderr to `healix-reports/playwright-stderr.log`.
- **Client/server timeout mismatch** (`webapp-client.js` + `vercel.json`): MCP client was aborting at 120s exactly when the webapp's `/api/generate-tests` finished. Per-endpoint ceilings now — MCP: generate 300s / parsePRD 240s / plan 180s / analyze 180s / ingest 60s / validate 6s / phase 4s. Vercel `maxDuration` matched.
- **Cleanup script** (`scripts/cleanup.sh`): wipes `/tmp/claude-501/`, `testbot-mcp/test/tmp/`, optional extra paths. Unbound-safe under `set -u`.

## v1.1 Failure-Triage Progress

**Plan**: `~/.claude/plans/resilient-popping-marshmallow.md` — Healix v1.1, phases T1-T8.

### T1 Pipeline-Error Surfacing — ✅ DONE (2026-04-18)

- `pipeline-worker.js`: `buildPipelineDiagnostics()` now attaches `error.diagnostics = { kind: 'pipeline', stage, reason, stderr, stdout, firstSpecPreview, generatedSpecCount, qualityAuditErrors }` on every validation/quality-audit failure path; runPipeline catch block assembles a `pipelineError` object from diagnostics + errorCode + userFacingMessage and passes it to `reportGen.generate()`.
- `report-generator.js`: `generate()` accepts `pipelineError` and includes it both inside `report.pipelineError` and as top-level `pipeline_error` on the ingest POST body.
- `webapp/drizzle/0005_pipeline_error.sql` applied: `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS pipeline_error jsonb` (applied directly via raw SQL, Drizzle journal still out of sync from earlier 0004 drift).
- `webapp/src/lib/db/schema.ts`: `pipelineError: jsonb('pipeline_error')` added to `test_runs`.
- `webapp/src/lib/types/database.ts`: new `PipelineError` shape + `test_run.pipeline_error`.
- `webapp/src/app/api/test-runs/ingest/route.ts`: accepts `pipeline_error` top-level (also falls back to `report.pipelineError`); forces `status='error'` when present.
- `webapp/src/app/api/test-runs/[id]/route.ts`: returns `pipeline_error` (and `tier_results` — latent bug fixed incidentally) on both the ingested-row and live-fallback responses.
- `webapp/src/app/(dashboard)/test-run/[id]/page.tsx`: new `<PipelineErrorBanner/>` renders a red banner with stage/reason/code chips, collapsible stderr pre-block, collapsible first-spec preview, and an "Ask Cursor agent to fix" button that copies a full diagnostic prompt to the clipboard. The synthetic `[PIPELINE]/[HEALIX]` fake-test row is hidden whenever `pipeline_error` is set (dedupes with the banner).
- `webapp/src/app/api/analyze-failures/route.ts`: new `kind: 'pipeline'` branch with `PIPELINE_SYSTEM_PROMPT` + `buildPipelinePrompt` — fixTarget ∈ `test_generation | test_runner_config | dependencies | env | app | unknown`, grounded in stderr + firstSpecPreview instead of a per-test `{ testName, error }` blob.

### Still open (v1.1)

- **T2 — Evidence bundler + Playwright retries**: trace-parser (Playwright `trace.zip` → `TraceEvidence`), evidence-bundler (test source + AC + exploration-route entry), per-tier retries (2/2/1), `flaky` status.
- **T3 — Deterministic classifier + cluster detection**: 6 first-match rules + `{selector, reason}` clustering with ≥3-member rollup, emits `Verdict` with confidence.
- **T4 — `/api/analyze-failures` v2 (two-hypothesis AI)**: `test_is_wrong | app_is_wrong | environment | ambiguous`, anti-bias prompt clause, patch guardrail (`[REQ:]` + `expect(...)`).
- **T5 — `test_failures` table + ingest + `/failure-verdict` override route**: `0006_test_failures.sql`, user override buttons persist as training labels.
- **T6 — Dashboard verdict chips + evidence tabs + cluster banner**: replace "Likely Cause" box with verdict chip; 4-tab evidence panel (Test asked for / App rendered / AC says / Suggested patch).
- **T7 — MCP Cursor-agent handoff**: `healix_analyze_failures` returns `auto_apply` (conf≥0.85 + `[REQ:]` preserved) vs `surface_for_approval` vs `app_regressions` vs `environment_issues`; `HEALIX_AUTO_APPLY_TEST_PATCHES` kill switch; MCP re-verifies `oldCode` matches verbatim before applying.
- **T8 — Triage verification**: hallucinated-selector / real-regression / pipeline-error / flake / cluster / user-override scenarios; rolls into Phase H live Cursor verification.

### Background (unchanged)

- `maxDuration: 300` on Vercel requires Pro. Hobby caps at 60s. Confirm before first prod push.
- Phase H (live Cursor verification) still pending — unblocks after T8.

## Critical files to know

| Area | Path |
|---|---|
| MCP entry | `testbot-mcp/bin/healix-mcp.js`, `testbot-mcp/src/index.js` |
| Orchestrator | `testbot-mcp/src/pipeline-worker.js` |
| Webapp client | `testbot-mcp/src/webapp-client.js` |
| Generation validation | `pipeline-worker.js:1254` (`validateGeneratedTestsWithList`), `:1327` (`auditGeneratedTestQuality`) |
| Tier split | `testbot-mcp/src/playwright-integration.js`, `results-merger.js` |
| Ingest | `webapp/src/app/api/test-runs/ingest/route.ts` |
| AI triage (current) | `webapp/src/app/api/analyze-failures/route.ts` |
| Dashboard failure UI | `webapp/src/app/(dashboard)/test-run/[id]/page.tsx` (TestRow, matchedAi) |
| Deploy config | `vercel.json`, `webapp/next.config.ts`, `webapp/package.json` |
