-- Add per-agent attribution to AI calls so per-agent token/latency/cost
-- dashboards become a simple GROUP BY agent. Null for non-agent AI calls.
ALTER TABLE mcp_telemetry_events
  ADD COLUMN IF NOT EXISTS agent TEXT,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

CREATE INDEX IF NOT EXISTS mcp_telemetry_agent_idx ON mcp_telemetry_events (agent);

-- Durable pipeline state on test_runs. On each phase transition the MCP
-- (via /api/test-runs/ingest or a new light-weight /api/test-runs/phase)
-- writes the current phase + timestamp so a crashed run's dashboard can
-- show "last seen at tier-B auth probe 3 minutes ago".
ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS current_phase TEXT,
  ADD COLUMN IF NOT EXISTS current_phase_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tier_results JSONB;

CREATE INDEX IF NOT EXISTS test_runs_current_phase_idx ON test_runs (current_phase);
