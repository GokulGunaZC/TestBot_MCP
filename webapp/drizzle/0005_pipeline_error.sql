-- Phase T1: pipeline-level errors need a structured home on test_runs so the
-- dashboard can render a proper failure banner (stage + reason + stderr + first-
-- spec preview) instead of the generic "Pipeline failed" text collapsed into a
-- fake 0.00s test. The full triage table (test_failures) lands in 0006.
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS pipeline_error jsonb;
