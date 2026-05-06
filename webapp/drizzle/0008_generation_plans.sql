-- P1.5 — frontend/backend planner pass cache.
--
-- A single GenerationPlan is computed per (user, plan_hash) BEFORE the
-- per-agent generation fan-out. The plan hash hashes
--   { prd, parsedPRD, contextDigest, projectInfoDigest, roles }
-- so repeat pipeline runs against the same repo snapshot skip the two
-- gpt-5.4 planner calls. Rows older than 24h are ignored by the route
-- (SELECT ... WHERE created_at > now() - interval '24 hours'); we keep
-- older rows for post-mortem debugging rather than auto-deleting.
--
-- IMPORTANT: apply manually via `psql` / Supabase SQL editor if the Drizzle
-- journal is out of sync (it is, historically — see MIGRATION.md).

CREATE TABLE generation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_hash text NOT NULL,
  plan_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX generation_plans_user_hash_idx
  ON generation_plans(user_id, plan_hash);
CREATE INDEX generation_plans_user_recent_idx
  ON generation_plans(user_id, created_at DESC);

-- To revert:
-- DROP INDEX IF EXISTS generation_plans_user_recent_idx;
-- DROP INDEX IF EXISTS generation_plans_user_hash_idx;
-- DROP TABLE IF EXISTS generation_plans;
