-- Phase T5 — failure triage table.
--
-- One row per failed Playwright test carries the evidence bundle + deterministic
-- classifier verdict + AI verdict + (optional) user override. The dashboard
-- reads these rows to render verdict chips / cluster banners, and the
-- override endpoint (POST /api/test-runs/[id]/failure-verdict) writes back to
-- user_override for training-label collection.
--
-- IMPORTANT: apply manually via `psql` / Supabase SQL editor if the Drizzle
-- journal is out of sync (it is, historically — see MIGRATION.md).

CREATE TABLE IF NOT EXISTS test_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  test_name text NOT NULL,
  test_file text,
  tier text,                             -- tierA-public | tierB-auth-{role} | tierC-backend

  verdict text NOT NULL,                 -- test_is_wrong | app_is_wrong | environment | ambiguous
  verdict_source text NOT NULL,          -- classifier | ai | user_override
  verdict_confidence numeric(3, 2),
  fix_target text,                       -- test | app | env | none
  reason text,

  suggested_patch jsonb,
  evidence jsonb,                        -- full FailureEvidence bundle (trace + AC + route)
  cluster_id text,                       -- groups ≥3 failures with same signature

  user_override text,                    -- null until the user clicks a verdict button
  user_override_at timestamptz,

  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS test_failures_run_idx
  ON test_failures(test_run_id);
CREATE INDEX IF NOT EXISTS test_failures_user_verdict_idx
  ON test_failures(user_id, verdict);
CREATE INDEX IF NOT EXISTS test_failures_cluster_idx
  ON test_failures(test_run_id, cluster_id);
