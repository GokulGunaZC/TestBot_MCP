# Healix

**End-to-end QA automation in one command, from your IDE.**

Healix is a Model Context Protocol (MCP) server that generates acceptance-criteria-traced Playwright tests, runs them in tiers, and opens a dashboard — all from a single prompt in Cursor, Claude Code, or Windsurf. All AI calls are proxied through the Healix webapp, so users only need a `HEALIX_API_KEY`.

## Quick Start

### 1. Install

```bash
npm install -g @healix/mcp
```

### 2. Configure MCP

Add to your MCP settings (`~/.cursor/mcp.json`, Claude Code, or Windsurf):

```json
{
  "mcpServers": {
    "healix": {
      "command": "npx",
      "args": ["@healix/mcp"],
      "env": {
        "HEALIX_API_KEY": "your-healix-api-key"
      }
    }
  }
}
```

Get your API key at your Healix dashboard.

### 3. Test Your App

In your IDE:

> "Test my app using the healix mcp"

Healix will:

1. Open a local configuration UI (test type, optional PRD, role credentials)
2. Auto-detect project settings (port, base URL, start command)
3. Explore your app with browser-use to discover real flows
4. Generate AC-traced tests (each test tagged `[REQ:F1.S1.AC1]`)
5. Run Playwright tests in tiers:
   - **Tier A** — public flows (no auth required)
   - **Tier B** — authenticated flows per role
   - **Tier C** — backend / API contract
6. Analyze failures with AI
7. Open a dashboard with tier pills, screenshots, traces, and AI analysis

If login fails, Healix re-prompts for credentials; if login still fails, Tier B is marked `blocked` and Tiers A and C still run — you always get a partial green.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HEALIX_API_KEY` | Required. Your Healix API key (authenticates and meters token usage). | - |
| `HEALIX_DASHBOARD_URL` | Optional. Dashboard base URL. | Production Vercel URL |

No other keys are required. OpenAI calls are proxied server-side through the Healix webapp.

### Tool Parameters

The `healix_test_my_app` tool accepts:

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string | Path to project (default: workspace root) |
| `testType` | string | `frontend`, `backend`, or `both` |
| `prdFile` | string | Path to PRD file for AC extraction |
| `baseURL` | string | Application base URL |
| `port` | number | Application port |
| `startCommand` | string | Command to start the app |

## Dashboard

The dashboard displays:

- **Tier pills**: passed / failed / blocked per tier (public, auth-{role}, backend)
- **KPI cards**: total tests, pass rate, duration
- **AI failure analysis**: root cause + suggested fix per failure
- **Artifacts**: screenshots, videos, Playwright traces (hosted on Supabase Storage)
- **Regression comparison**: compare against baseline runs

## Architecture

```
User IDE (Cursor / Claude Code / Windsurf)
        │  stdio MCP
        ▼
@healix/mcp  ──── thin client (HEALIX_API_KEY only) ────┐
        │                                               │
        │ 1. Config UI (local http)                     │
        │ 2. Auto-detect project                        │
        │ 3. Browser-use exploration (auto-install)     │
        │ 4. Credentials injector (per role)            │
        │ 5. Playwright tiered execution                │
        │ 6. Dashboard deep-link                        │
        │                                               │
        │ All AI prompts ─► HTTPS ──────────────────────┤
        ▼                                               ▼
Healix webapp (Vercel)                        OpenAI (server-side key only)
```

## Project Structure

```
TestBot_MCP/
├── testbot-mcp/            # @healix/mcp — the MCP server (publishes to npm)
│   ├── src/
│   │   ├── index.js                   # MCP tool registration
│   │   ├── auto-detector.js           # Project settings detection
│   │   ├── pipeline-worker.js         # End-to-end orchestration
│   │   ├── webapp-client.js           # All AI proxied through webapp
│   │   ├── browser-use-driver.js      # Browser-use subprocess bridge
│   │   ├── exploration-phase.js       # Browser-use exploration + auth probe
│   │   ├── credentials-injector.js    # Per-role Playwright storageState
│   │   ├── playwright-integration.js  # Tier A / B / C Playwright projects
│   │   ├── results-merger.js
│   │   └── ai-providers/
│   │       └── saas-client.js         # Proxy to Healix webapp
│   └── scripts/
│       └── browser_use_runner.py      # Pinned browser-use driver
└── webapp/                 # Next.js webapp on Vercel
    ├── src/app/api/
    │   ├── generate-tests/            # AC-traced test generation
    │   ├── parse-prd/                 # Structured AC extraction
    │   ├── exploration/plan/          # Prioritize observed flows
    │   ├── analyze-failures/
    │   ├── artifacts/                 # Supabase Storage
    │   └── test-runs/ingest/
    └── drizzle/                       # Postgres migrations
```

## Live Customers

Three customer deployments are using Healix in production. See `MIGRATION.md` for upgrading from older `@testbot/mcp` installs.

## License

MIT
