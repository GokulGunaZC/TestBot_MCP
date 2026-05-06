-- Phase 2 — async test generation jobs.
--
-- Backs the Inngest-driven test-generation pipeline. One row per enqueued
-- generation job tracks its lifecycle (queued → running → succeeded/failed/
-- partial), the per-agent progress, the original request payload, and the
-- terminal result or error envelope. The dashboard and the API both read
-- these rows to poll job status and surface partial results.
--
-- Design decisions:
--  * api_key_id uses ON DELETE SET NULL so rotating keys does not erase
--    audit history for past generations.
--  * test_run_id uses ON DELETE SET NULL — the job may be enqueued before
--    the test_runs row materializes, and test_runs rows can be purged
--    independently of job history.
--  * CHECK constraint on status prevents app bugs from writing an unknown
--    enum value.
--  * Partial unique index on (user_id, idempotency_key) enforces per-user
--    idempotency (not global) while allowing many rows with NULL keys.
--
-- IMPORTANT: apply manually via `psql` / Supabase SQL editor if the Drizzle
-- journal is out of sync (it is, historically — see MIGRATION.md).

CREATE TABLE generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  test_run_id uuid REFERENCES test_runs(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','partial')),
  payload jsonb NOT NULL,
  agents_requested text[] NOT NULL,
  agents_completed text[] NOT NULL DEFAULT '{}',
  result jsonb,
  error jsonb,
  idempotency_key text,
  created_at timestamptz DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX generation_jobs_user_idx ON generation_jobs(user_id, created_at DESC);
CREATE INDEX generation_jobs_status_idx ON generation_jobs(status) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX generation_jobs_idem_idx ON generation_jobs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- To revert:
-- DROP INDEX IF EXISTS generation_jobs_idem_idx;
-- DROP INDEX IF EXISTS generation_jobs_status_idx;
-- DROP INDEX IF EXISTS generation_jobs_user_idx;
-- DROP TABLE IF EXISTS generation_jobs;
