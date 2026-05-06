-- Migration: 0003_token_system
-- Adds token-based usage tracking to profiles and mcp_telemetry_events

-- profiles: token balance columns
-- Allocation based on $12 internal cost at GPT-5.4 (80% input/$2.50 + 20% output/$15 = $5/1M blended)
-- $12 / $5 × 1M = 2,400,000 tokens per Starter plan unit
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "tokens_remaining" bigint NOT NULL DEFAULT 240000;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "tokens_total" bigint NOT NULL DEFAULT 240000;

-- Backfill existing users based on their current plan
UPDATE "profiles" SET "tokens_remaining" = 2400000, "tokens_total" = 2400000 WHERE plan = 'starter';
UPDATE "profiles" SET "tokens_remaining" = 4800000, "tokens_total" = 4800000 WHERE plan = 'team';
UPDATE "profiles" SET "tokens_remaining" = 240000,  "tokens_total" = 240000  WHERE plan NOT IN ('starter', 'team', 'enterprise');

-- mcp_telemetry_events: token usage + internal cost tracking per AI call
ALTER TABLE "mcp_telemetry_events" ADD COLUMN IF NOT EXISTS "model_used" text;
ALTER TABLE "mcp_telemetry_events" ADD COLUMN IF NOT EXISTS "tokens_prompt" integer;
ALTER TABLE "mcp_telemetry_events" ADD COLUMN IF NOT EXISTS "tokens_completion" integer;
ALTER TABLE "mcp_telemetry_events" ADD COLUMN IF NOT EXISTS "tokens_total" integer;
ALTER TABLE "mcp_telemetry_events" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 8);
