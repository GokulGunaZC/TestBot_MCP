# Healix v1.2 — "No Silent Failure" hardening plan

## Goal

Every possible outcome of a Healix run must produce **exactly one
actionable surface** for (a) the user on the dashboard and (b) the
Cursor agent on MCP. "The pipeline hung", "the agent went idle", "the
banner says unknown", "the webapp ran out of tokens without telling
anyone" must all be impossible states.

This plan consolidates what landed in the 2026-04-18 batch and
enumerates the remaining silent-failure surfaces we still need to
close before calling v1.2 done.

## What already landed (carry-over from v1.1 + today's batch)

| # | Surface | Landed in |
| --- | --- | --- |
| A | `stage: unknown` / `reason: unknown_reason` → stderr-pattern classifier + 9 rules + ordering test | `testbot-mcp/src/failure-triage/pipeline-error-classifier.js` |
| B | pm-app ESM/CJS fixture mismatch → project-aware emitter + regression test | `testbot-mcp/src/pipeline-worker.js` (`detectProjectModuleType`, `getCursorFixtureContent`) |
| C | Cursor agent went idle after `healix_test_my_app` returned → new `healix_check_run_status` tool + instructions in the tool response | `testbot-mcp/src/index.js` |
| D | Dashboard KPIs lying ("Total 1 / Failed 1" on a no-tests-ran pipeline error) → zero stats when `pipelineError` is set | `webapp/src/app/(dashboard)/test-run/[id]/page.tsx` |
| E | Stray "0" rendering below the test-run page → fixed the `{duration_ms && …}` JSX numeric footgun | same file |
| F | Sidebar "1032" vs plan card "50/50" divergence → consolidated on `tokens_remaining` + shared `toDisplayUnits()` helper + auth gate now blocks on `tokens_remaining <= 0` | `lib/token-units.ts`, `lib/tokens.ts`, `layout.tsx`, `home/page.tsx`, `plan-billing/page.tsx`, `mcp-auth/validate/route.ts` |

Coverage: 98 MCP tests (97 pass, 1 cleanly skipped), webapp
`tsc --noEmit` clean of new errors.

## Silent-failure surfaces still open

Each item below is something a user or the Cursor agent could still
hit today without getting an actionable signal. Ordered by user
impact.

### S1. SSE stream dies mid-run → dashboard appears frozen

**Symptom:** the live-pipeline card shows "generating tests" forever
because the SSE connection was cut (laptop sleep, proxy idle
timeout, Vercel function restart). Nothing on the page tells the user
the stream is stale; the underlying run may have already finished.

**Fix shape:**

- Heartbeat every 15s from the MCP telemetry sink. If the dashboard
  hasn't received a frame in 45s, show a "Stream paused — refresh to
  reconnect" toast **and** kick off a one-shot HTTP fetch of the
  latest `status.json` so the user can at least see terminal state.
- Server-side: emit a `noop` frame on a 15s interval so proxies
  don't drop the connection.

**Files:** `webapp/src/app/(dashboard)/test-run/[id]/page.tsx` (client
SSE hook), `webapp/src/app/api/test-runs/[id]/stream/route.ts`.

### S2. Background pipeline worker crashes without writing terminal status

**Symptom:** `healix_check_run_status` polls forever; `phase` never
enters a terminal set. The agent's "poll until terminal" loop never
exits.

**Root cause today:** the worker child writes `phase: 'error'` inside
its own `catch`; if the process segfaults or is OOM-killed, no catch
fires, so `status.json` is left in the last in-flight phase.

**Fix shape:**

- Parent (`handleTestMyApp`) registers `child.on('exit', …)` and, if
  the exit code is non-zero AND the last `status.json` phase is not
  terminal, writes a synthetic `{ phase: 'error', errorCode:
  'WORKER_DIED', message: 'Pipeline worker exited with code N' }`.
- `healix_check_run_status` gains a wall-clock watchdog: if
  `timestamp` on status is > 10 min stale AND phase not terminal,
  synthesize `{ phase: 'error', errorCode: 'WATCHDOG_TIMEOUT' }` in
  the response so the agent can stop polling.

**Files:** `testbot-mcp/src/index.js` (both the spawn site and
`handleCheckRunStatus`).

### S3. User out of tokens → 402 from `/api/generate-tests` but the dashboard banner is still "unknown"

**Symptom:** `checkTokenBalance` returns `{ allowed: false }`; the
pipeline worker surfaces a generic "AI generation failed" but neither
the dashboard banner nor the agent response explicitly says "you're
out of tokens, upgrade your plan."

**Fix shape:**

- Add `no_tokens` classifier rule (matches `NO_TOKENS` from
  `security-logger.ts` taxonomy + any 402 from webapp) with
  `userFacingMessage: 'You are out of tokens. Top up at /plan-billing
  or upgrade plans.'`
- Gate the banner's CTA: when `errorCode === 'NO_TOKENS'`, render an
  "Upgrade" button next to the usual "Ask Cursor" button.
- Agent handoff: put `NO_TOKENS` failures in a new
  `billing_issues` bucket alongside `environment_issues` so the
  Cursor agent relays it as a user-action-required message rather
  than trying to auto-fix.

**Files:** `testbot-mcp/src/failure-triage/pipeline-error-classifier.js`,
`testbot-mcp/src/failure-triage/agent-response.js`,
`webapp/src/app/(dashboard)/test-run/[id]/page.tsx` (`PipelineErrorBanner`).

### S4. Webapp unreachable during MCP ingest → results lost

**Symptom:** Cursor runs Healix offline or against a Vercel deploy
that's rate-limiting. `webapp-client` catches the failure, logs, and
moves on — the run is on disk locally but the dashboard never sees it.

**Fix shape:**

- MCP: persist a retryable queue at `healix-reports/.ingest-queue/*.json`.
  On the next MCP tool invocation (any tool, with any project), drain
  the queue before doing new work.
- Telemetry: emit `ingest_queued` + `ingest_retry_succeeded` events.

**Files:** `testbot-mcp/src/webapp-client.js`,
`testbot-mcp/src/index.js` (tool prelude).

### S5. Generated-test TypeScript compilation errors (distinct from runtime SyntaxError)

**Symptom:** `playwright test --list` fails because a generated
`.spec.ts` doesn't typecheck (missing `@types/…`, drifted API
shape). Today the stderr classifier's `generated_test_syntax_error`
rule catches most of these, but TS-specific errors like "Property 'X'
does not exist on type 'Y'" slip to
`unclassified_pipeline_error`.

**Fix shape:** add a `generated_test_type_error` rule keyed on
`/TS\d{4}:/` or `Property '[^']+' does not exist on type` patterns.
User-facing message should point at regenerating with
`strictAIGeneration: true` rather than hand-editing.

**Files:** `pipeline-error-classifier.js` + matching test case.

### S6. `/api/analyze-failures` timeout (> 180s) silently truncates the agent response

**Symptom:** on runs with 8 failures of evidence-heavy traces, the
analyzer can exceed Vercel's 180s limit. Right now MCP treats this as
a generic error — the per-failure analyses array is empty, the
dashboard shows no verdict chips, and the agent response lists
everything under `surface_for_approval` with confidence 0.

**Fix shape:**

- Webapp: stream per-failure results back as soon as each finishes;
  never buffer all 8 before returning.
- MCP: fall back to the deterministic classifier verdicts when the
  AI verdicts are missing, so a timeout degrades to "classifier-only"
  rather than "nothing".

**Files:** `webapp/src/app/api/analyze-failures/route.ts`,
`testbot-mcp/src/webapp-client.js`.

### S7. Dashboard shows a run with `pipeline_error` but no stderr attached

**Symptom:** early Healix versions wrote pipeline errors without the
structured diagnostics block. Loading an old run renders the banner
with "stderr not available" — functional, but not helpful.

**Fix shape:** backfill script that walks `test_runs.pipeline_error`
rows with null stderr and runs the classifier on whatever message is
available so at least `stage` and `reason` can be set. Write-once.

**Files:** `webapp/scripts/backfill-pipeline-errors.ts` (new),
one-off.

### S8. User overrides verdict but MCP auto-apply already patched the file

**Symptom:** agent auto-applies a `test_is_wrong` patch at
confidence 0.9. User opens dashboard, clicks "App wrong" override.
The patch is already in git; nothing rolls it back.

**Fix shape:** when an override flips a verdict that had already
been auto-applied, the dashboard shows a persistent banner: "The AI
patched `tests/generated/foo.spec.ts`. You've overridden the verdict
— revert with `git restore tests/generated/foo.spec.ts` or run Healix
again to regenerate."  Include the `git restore` command as
one-click copy.

**Files:** `webapp/src/app/(dashboard)/test-run/[id]/page.tsx`
(verdict-override handler); requires a new `auto_applied` boolean on
`test_failures`.

## Order and effort

- **S2 first** (watchdog + worker-exit handler) — closes the
  still-possible "agent polls forever" path. ~0.5 day.
- **S3** (NO_TOKENS surface) — user-visible. ~0.5 day.
- **S1** (SSE heartbeat) — visible polish; ~1 day (client + server).
- **S4** (ingest retry queue) — ~0.5 day.
- **S5** (TS error classifier) — ~2 hours.
- **S6** (analyze-failures streaming) — ~1 day.
- **S7** (backfill) — ~2 hours, one-off.
- **S8** (auto-apply revert banner) — ~0.5 day, requires DB migration.

**Total ≈ 4.5 engineering days.** S1+S2+S3 together cover ~90% of
the "user thinks Healix hung" reports; ship those first and
re-evaluate.

## Test matrix (what each phase needs to verify)

Each phase lands with at least one Node test OR one end-to-end
scenario in `testbot-mcp/test/triage-e2e.test.js`:

- S1: drop the SSE socket mid-run → dashboard shows stale toast
  within 45s + one-shot fetch recovers state.
- S2: `kill -9` the worker → `healix_check_run_status` returns
  `phase: 'error', errorCode: 'WORKER_DIED'` within 10 min.
- S3: set `tokens_remaining = 0` → run a pipeline → banner shows
  "out of tokens" with Upgrade CTA; MCP response puts it in
  `billing_issues`.
- S4: block the webapp host at the firewall → re-enable after a
  run → next MCP invocation drains the queue and the dashboard shows
  the backdated run.
- S5: synthesise `TS2339` in a generated spec → classifier returns
  `generated_test_type_error`.
- S6: mock the analyzer to hang 200s → MCP response still has
  classifier verdicts with `verdictSource: 'classifier'`.
- S7: `UPDATE test_runs SET pipeline_error = '{"kind":"pipeline"}'
  WHERE id = …` then run backfill → `stage`, `reason`,
  `userFacingMessage` populated.
- S8: auto-apply a patch → override to `app_is_wrong` → banner
  renders with `git restore` CTA.

## Non-goals for v1.2

- Multi-framework exploration (Vite / CRA / Remix first-class) — still
  deferred to v1.3.
- Self-healing of the *app* source (we only auto-apply test patches).
- Windows support for `SourceTextModule`-based fixture validation
  (the existing static-regex regression guard already covers the
  primary risk).
