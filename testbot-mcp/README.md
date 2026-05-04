# @healix/mcp

**Version:** 2.0.0 | **Node:** ≥18.0.0

Thin-client MCP server for AI-powered end-to-end test generation and execution. Installed in developer IDEs (Cursor, Claude Code, Windsurf) — requires only a `HEALIX_API_KEY`. All AI calls are proxied through the Healix webapp; no OpenAI key needed on user machines.

See the [top-level README](../README.md) for the full product overview and architecture diagram.

## Install

```bash
npm install -g @healix/mcp
```

## MCP Configuration

Add to your IDE's MCP settings (`~/.cursor/mcp.json`, Claude Code config, or Windsurf):

```json
{
  "mcpServers": {
    "healix": {
      "command": "npx",
      "args": ["@healix/mcp"],
      "env": {
        "HEALIX_API_KEY": "hlx_..."
      }
    }
  }
}
```

## MCP Tools

### `healix_test_my_app`

Runs the full end-to-end testing pipeline. Key parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string | Path to the project under test (default: workspace root) |
| `baseURL` | string | App base URL |
| `port` | number | App port |
| `startCommand` | string | Command to start the app |
| `testType` | `frontend` \| `backend` \| `both` | Test scope |
| `generateTests` | boolean | Whether to generate new tests (default: `true`) |
| `openDashboard` | boolean | Whether to open dashboard after run (default: `true`) |
| `prdFile` | string | Path to PRD/requirements file for AC extraction |
| `credentials` | object \| array | Role credentials for authenticated flows |
| `codebaseContext` | object | `{ pages, apiEndpoints, workflows }` passed to the generator |
| `playwrightMcp` | object | Options for `@playwright/mcp` integration |
| `force` | boolean | `true` to start fresh even if a recent run exists (default: `false`) |

### `healix_configure`

Opens the config UI form and returns validated settings without running the pipeline. Use for pre-flight validation or when you want to inspect auto-detected settings before committing to a run.

## Pipeline

`pipeline-worker.js` orchestrates these steps:

1. **Auto-detect** (`auto-detector.js`) — infers port, framework, and start command from the project
2. **App launch** (`multi-service-starter.js`) — starts the app under test
3. **Browser exploration** — `browser-use-driver.js` runs a Python subprocess (`scripts/browser_use_runner.py`) to discover real routes, forms, and auth flows; falls back to `playwright-explorer.js` (zero-dependency Playwright heuristic) if browser-use is unavailable
4. **PRD parse** — POSTs to `/api/parse-prd` for structured AC extraction; when AC count < 3, exploration `keyFlows` are promoted to primary generation input
5. **Test generation** — POSTs to `/api/generate-tests`; multi-agent fan-out via GPT; each test tagged `[REQ:F#.S#.AC#]`; validates that every generated spec contains at least one `expect()` call
6. **Credential injection** (`credentials-injector.js`) — per-role Playwright `storageState` written to `.healix/auth-state-{role}.json`
7. **Tiered execution** (`playwright-integration.js`):
   - `tierA-public` — unauthenticated flows
   - `tierB-auth-{role}` — one project per role; login failure → `blocked` (A + C still run)
   - `tierC-backend` — API/backend contract tests
8. **Artifact upload** (`artifact-uploader.js`) — screenshots, videos, traces → Supabase Storage (`.healix/auth-state-*.json` is blocklisted)
9. **Results merge** (`results-merger.js`) — combines tier results, adds `blocked` status
10. **Report + ingest** (`report-generator.js`) — builds payload and POSTs to `/api/test-runs/ingest`
11. **Dashboard** (`dashboard-launcher.js`) — opens the run page deep-link

### Failure triage (`failure-triage/`)

After execution, failures are processed through a three-layer pipeline:

- `classifier.js` — deterministic first-match rules (selector errors, network, timeout, etc.)
- `evidence-bundler.js` — bundles test source + AC + Playwright trace (`trace-parser.js` unpacks `trace.zip`)
- `pipeline-error-classifier.js` — classifies pipeline-level errors (generation, runner config, deps, env, app)
- `agent-response.js` — parses AI triage response
- `error-remediations.js` — maps verdicts to patch suggestions

### Retry loop guard

`index.js` checks `healix-reports/.runs/` for a recent run (< 10 min old). If found and errored, the tool returns an `isError` response telling the agent to fix the root cause rather than re-entering config. Pass `force: true` to bypass.

## Environment Variables

Set these in the `env` block of your MCP client config, or in a `.env` file adjacent to the package:

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `HEALIX_API_KEY` | **Yes** | Authenticates MCP → webapp; meters token usage. | — |
| `HEALIX_DASHBOARD_URL` | No | Webapp base URL for all API calls and dashboard deep-links. | Production Vercel URL |
| `HEALIX_RUN_BUDGET_MS` | No | Overall pipeline timeout (ms). | `3600000` (60 min) |
| `HEALIX_GEN_BUDGET_MS` | No | Test-generation stage timeout (ms). Raise for large codebases. | `900000` (15 min) |
| `HEALIX_SKIP_PLANNER` | No | Set `1` to bypass the pre-fan-out planner pass (emergency circuit breaker). | unset |

**Never set `OPENAI_API_KEY` in MCP config.** All AI calls proxy through the webapp. v2.0.0 removed every local AI client.

## Tests

26 test files using Node.js built-in `node:test` (no Jest, no Vitest):

```bash
# Run all tests
node --test test/*.test.js test/**/*.test.js

# Run a single file
node --test test/classifier.test.js
```

Coverage: pipeline phases, async job polling, failure triage classifier, AI response parsing, trace parsing, port pre-flight, credentials injection, artifact upload, planner, evidence bundler, flake detection, generation budget, report generator.

## Source Layout

```
src/
├── index.js                  # MCP server + tool registration (healix_test_my_app, healix_configure)
├── pipeline-worker.js        # End-to-end orchestration
├── auto-detector.js          # Port/framework/start-cmd detection
├── webapp-client.js          # All webapp API calls
├── config-ui-launcher.js     # Local HTTP config form
├── multi-service-starter.js  # App-under-test launcher
├── context-gatherer.js       # Codebase context extraction
├── browser-use-driver.js     # Python browser-use subprocess
├── playwright-explorer.js    # Zero-dep Playwright heuristic fallback
├── exploration-phase.js      # Exploration orchestration + auth probe
├── playwright-integration.js # Tier A/B/C Playwright project config
├── playwright-mcp-client.js  # @playwright/mcp integration
├── playwright-mcp-integration.js
├── credentials-injector.js   # Per-role storageState
├── artifact-uploader.js      # Supabase Storage upload
├── results-merger.js         # Merge tier results + blocked status
├── report-generator.js       # Build ingest payload
├── mcp-telemetry.js          # Background telemetry events
├── dashboard-launcher.js     # Open dashboard deep-link
├── logger.js
├── port-preflight.js
├── agent-context-requester.js
├── ai-providers/
│   ├── index.js
│   └── saas-client.js        # Proxy → Healix webapp
└── failure-triage/
    ├── classifier.js
    ├── agent-response.js
    ├── error-remediations.js
    ├── evidence-bundler.js
    ├── pipeline-error-classifier.js
    └── trace-parser.js
```
