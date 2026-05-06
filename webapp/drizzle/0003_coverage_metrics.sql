-- Migration: 0003_coverage_metrics
-- Adds coverage_metrics jsonb column to test_runs

ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "coverage_metrics" jsonb;
