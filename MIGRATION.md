# Migrating from `@testbot/mcp` or `@healix/mcp@1.x` → `@healix/mcp@2.0.0`

`@healix/mcp@2.0.0` is the first fully thin-client release. It removes every
user-side AI key requirement — billing and AI calls happen server-side through
the Healix webapp.

## Breaking changes

### 1. `OPENAI_API_KEY` is no longer read by the MCP

Previous releases fell back to a local OpenAI client when the webapp was
unreachable or for certain test types. That code path is gone. The only
required env var now is `HEALIX_API_KEY`.

If your `mcp.json` sets `OPENAI_API_KEY`, `SARVAM_API_KEY`, `CASCADE_API_KEY`,
`WINDSURF_API_KEY`, or `AI_PROVIDER` in the `env` block, **remove them**. They
are ignored in 2.0.0.

### 2. Package name: `@testbot/mcp` → `@healix/mcp`

```bash
npm uninstall -g @testbot/mcp
npm install -g @healix/mcp
```

Update your MCP config:

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

### 3. Tier-split test execution

Tests are now executed under three Playwright projects:

- `tierA-public` — public / unauthenticated flows
- `tierB-auth-<role>` — one project per role, backed by a verified `storageState`
- `tierC-backend` — API / backend contract

If login fails for a role, that role's Tier B is marked `blocked` instead of
`failed`; Tiers A and C still run. The dashboard shows a pill per tier.

### 4. Browser-use exploration is opt-out, not opt-in

On first run, Healix tries to run browser-use to explore your app. If
`browser-use` isn't installed, Healix falls back to a zero-dependency
Playwright heuristic explorer — nothing blocks. To skip exploration entirely,
pass `skipExploration: true` to `healix_test_my_app`.

## Dashboard

Tier results (`tier_results`) are now included in every ingest payload and
rendered as colored pills on the run page. No user action needed.

## Verifying the upgrade

```bash
npx @healix/mcp --version   # 2.0.0
```

Start a new run and confirm the dashboard shows tier pills. If you see a
"HEALIX_API_KEY is required" error on any MCP call, your config still has the
old env var wired up — update `mcp.json` as above.
