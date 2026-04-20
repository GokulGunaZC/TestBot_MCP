# @healix/mcp

MCP server that generates AC-traced Playwright tests and runs them in tiers. Published to npm as `@healix/mcp`.

See the [top-level README](../README.md) for the full product overview, install instructions, and architecture diagram. This file documents the env vars specific to the MCP package.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HEALIX_API_KEY` | Required. Authenticates the MCP against the webapp; meters token usage. | - |
| `HEALIX_DASHBOARD_URL` | Optional. Dashboard base URL (also used for all webapp API calls). | Production Vercel URL |
| `HEALIX_RUN_BUDGET_MS` | Optional. Overall run budget in milliseconds. | `3600000` (60 min) |
| `HEALIX_GEN_BUDGET_MS` | Optional. Test-generation stage budget. Raise for large codebases. | `900000` (15 min) |
| `HEALIX_GEN_ASYNC` | Optional. Enables background-job generation for very large codebases. Requires webapp to have Inngest configured; safe to leave false. | `false` |
| `HEALIX_SKIP_PLANNER` | Optional. Set to `1` to bypass the pre-fan-out planner pass as an emergency circuit breaker. | (unset) |

Set these via the `env` block of your MCP client config (Cursor, Claude Code, Windsurf) or via shell env.
