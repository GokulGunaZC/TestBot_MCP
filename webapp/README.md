# Healix Webapp

Next.js 16 / React 19 webapp deployed on Vercel. Hosts all AI calls, authentication, artifact storage, the dashboard UI, and the Inngest async generation pipeline.

See the [top-level README](../README.md) for the full product overview and architecture.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **UI**: React 19, Tailwind CSS v4, Framer Motion
- **Auth + Storage**: Supabase (Auth + PostgreSQL + Storage)
- **ORM**: Drizzle ORM (schema in `src/lib/db/schema.ts`, migrations in `drizzle/`)
- **Async jobs**: Inngest (optional, for large-codebase generation)
- **AI**: OpenAI (server-side only — key never touches user machines)

## Local Development

```bash
# From the monorepo root:
npm run dev:webapp          # Start Next.js dev server on 0.0.0.0:3000

# Or directly from webapp/:
npm run dev                 # same as above
npm run build               # Production build
npm run start               # Serve production build
npm run lint                # ESLint
```

## Environment Setup

Copy `../.env.example` to `webapp/.env.local` and fill in values:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. Use direct connection (port 5432) for local dev; Supabase Transaction Pooler URI (port 6543) for production. |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Supabase anon key (public). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service role key — server-side only, never expose in client code. |
| `OPENAI_API_KEY` | **Yes** | OpenAI API key — used by generation, parse-prd, analyze-failures routes. |
| `OPENAI_MODEL` | No | Model override. Default: `gpt-5.5-mini`. |
| `HEALIX_GEN_ASYNC` | No | `true` routes test generation through Inngest background jobs. Default: `false`. |
| `INNGEST_EVENT_KEY` | Conditional | Required when `HEALIX_GEN_ASYNC=true`. |
| `INNGEST_SIGNING_KEY` | Conditional | Required when `HEALIX_GEN_ASYNC=true`. |
| `INNGEST_DEV` | No | Set `1` when running against local `inngest-cli`. |
| `HEALIX_PLANNER_AGENT` | No | `1` to enable LLM-driven planner pre-pass. Default: `0` (rule-based). |
| `AI_MAX_REQUESTS_PER_MINUTE` | No | Per-user AI rate-limit ceiling. Default: `20`. |

## Database

Drizzle ORM over PostgreSQL (Supabase). **The schema file is the source of truth — never edit SQL migrations manually.**

```bash
# From webapp/ (or use the monorepo root alias):
npm run db:generate   # Generate a new migration from schema.ts changes
npm run db:migrate    # Apply pending migrations to the connected DB
npm run db:push       # Push schema directly (dev only, no migration file)
npm run db:studio     # Open Drizzle Studio (visual DB browser)
```

### Key tables

| Table | Purpose |
|-------|---------|
| `profiles` | User accounts — plan, credits, token balance |
| `api_keys` | Hashed API keys per user (prefix + bcrypt hash) |
| `test_runs` | Execution results: tier results, pipeline errors, AI analysis (JSONB) |
| `test_failures` | Per-test failure verdicts with evidence and user override labels |
| `mcp_telemetry_events` | Pipeline event stream — powers live run monitoring via SSE |
| `generation_jobs` | Inngest async generation job lifecycle (queued → running → succeeded/failed/partial) |
| `generation_plans` | 24h planner-pass cache keyed by repo snapshot hash |
| `test_artifacts` | Screenshot / video / trace metadata + Supabase Storage paths |
| `import_sessions` | Groovy import session (Excel/CSV → test cases) |
| `imported_test_cases` | Parsed test cases from import |
| `generated_groovy_files` | Generated Groovy API test files |

## API Routes

| Route | Max Duration | Description |
|-------|-------------|-------------|
| `POST /api/generate-tests` | 800s | Multi-agent AC-traced test generation (sync or Inngest async) |
| `POST /api/parse-prd` | 600s | PRD/requirements → structured acceptance criteria (SHA-256 cached) |
| `POST /api/exploration/plan` | 600s | Rank observed flows, suggest AC |
| `POST /api/analyze-failures` | 600s | AI triage: per-test failures + pipeline-level errors |
| `POST /api/test-runs/ingest` | 60s | Ingest MCP run results |
| `PATCH /api/test-runs/phase` | 10s | Update current pipeline phase |
| `GET /api/test-runs/[id]` | — | Fetch single run (with pipeline_error + tier_results) |
| `GET /api/test-runs/[id]/stream` | — | SSE stream of live run events from `mcp_telemetry_events` |
| `POST /api/mcp-telemetry/ingest` | — | Ingest MCP telemetry events |
| `GET /api/mcp-telemetry/summary` | — | Per-user telemetry summary |
| `POST /api/mcp-auth/validate` | — | Validate `HEALIX_API_KEY` |
| `POST /api/import-tests` | — | Create import session from Excel/CSV |
| `POST /api/import-tests/[id]/generate` | 600s | Generate Groovy files from imported test cases |
| `GET /api/artifacts` | — | Supabase Storage artifact proxy |
| `POST /api/upload-artifacts` | — | Generate signed upload URLs |
| `GET/POST /api/api-keys` | — | API key CRUD |
| `GET/POST /api/inngest` | — | Inngest function registry + webhook |

All routes call `getCurrentUser()` and return `401` if unauthenticated. Ownership is enforced by including `userId` in every WHERE clause.

## Dashboard Pages

| Route | Description |
|-------|-------------|
| `/home` | Overview and recent test runs |
| `/create-tests` | Manual test run creation form |
| `/all-tests` | Full test run history |
| `/mcp-tests` | MCP-originated run history |
| `/test-run/[id]` | Live + historical run detail: tier pills, AI failure analysis, artifacts, pipeline error banner |
| `/import-tests` | Upload Excel/CSV → generate Groovy test files |
| `/monitoring` | Live MCP telemetry dashboard (real-time pipeline events) |
| `/api-keys` | Create, list, revoke API keys |
| `/plan-billing` | Plan, credits, and token balance |
| `/profile` | User profile |

## Test Generation Pipeline

### Sync (default)

`/api/generate-tests` runs the full multi-agent fan-out inline. The planner pass (`lib/test-generation/planner-agent.ts`) produces a `GenerationPlan`; `agent-dispatcher.ts` fans out to up to 6 agents (smoke, frontend, api, workflow, error, expansion) via `openai-generator.ts`. Results are assembled and returned synchronously.

Planner output is cached for 24h per `(userId, planHash)` in the `generation_plans` table — repeat runs against the same repo snapshot skip two GPT calls.

### Async (Inngest)

When `HEALIX_GEN_ASYNC=true`:

1. `/api/generate-tests` enqueues an Inngest event and returns `202 { jobId }`.
2. `generate-tests-orchestrator` fans out to parallel `generate-tests-agent` jobs.
3. The MCP polls `/api/generate-tests/jobs/{jobId}` until `succeeded` or `failed`.
4. Partial results are written to the `generation_jobs` row as each agent completes.

#### Local Inngest dev

```bash
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

The CLI auto-discovers `generate-tests-orchestrator` and `generate-tests-agent` and streams event runs.

#### Production

Link the Vercel deployment to Inngest via the Inngest Vercel integration. Verify:
- `GET /api/inngest` returns 200 with the function registry.
- Both functions appear in the Inngest dashboard.
- Webhook signature validation passes (check Inngest → Deliveries).

**Do not enable `HEALIX_GEN_ASYNC=true` for local dev** — there is no function-timeout constraint on localhost, and the async path adds Inngest setup overhead for no benefit.

#### Cost

Inngest free tier: 25k function runs/month. Each generation job: 1 orchestrator + up to 6 agent runs = 7 runs/job.

#### Troubleshooting

- `inngest.send` failure → `/api/generate-tests` falls back to the sync path automatically.
- Missing `202` response → verify `HEALIX_GEN_ASYNC=true` is set on the Vercel environment for the deployed branch.
- Stuck poll → inspect `SELECT * FROM generation_jobs WHERE id = '<jobId>'` and the matching Inngest run.

## AI Failure Analysis

`/api/analyze-failures` handles two analysis modes:

- **Per-test failures** — two-hypothesis analysis (`test_is_wrong` vs `app_is_wrong` vs `environment` vs `ambiguous`); grounded in test source + AC + Playwright trace evidence.
- **Pipeline errors** (`kind: 'pipeline'`) — classifies against `fixTarget ∈ {test_generation, test_runner_config, dependencies, env, app, unknown}`; grounded in stderr + first-spec preview.

## Groovy Test Import

The `import-tests` feature allows teams to upload existing test cases from Excel/CSV files and auto-generate Groovy API test files:

1. `POST /api/import-tests` — parse and store test cases from upload (`excel-parser.ts`)
2. `POST /api/import-tests/[id]/generate` — generate Groovy files per test case (`groovy-generator.ts`)
3. Results stored in `import_sessions`, `imported_test_cases`, `generated_groovy_files`

## Vercel Deployment

`vercel.json` at the monorepo root configures:
- `buildCommand`: `cd webapp && npm run build`
- `outputDirectory`: `webapp/.next`
- Per-function `maxDuration` (generate-tests: 800s, parse-prd/exploration/analyze-failures/import-generate: 600s, ingest: 60s, phase: 10s)

> **Note:** `maxDuration > 60s` requires Vercel Pro. Hobby plan caps at 60s.

Body size limit: 25MB (set in `webapp/next.config.ts`).
