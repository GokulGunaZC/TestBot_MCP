-- Migration: 0010_fix_token_balances
-- Fixes two data anomalies:
-- 1. tokens_total out of sync with plan (e.g. stale 5,000,000 values set before the token system)
-- 2. tokens_remaining exceeds tokens_total (caused by old Math.max webhook logic in c3d85ba1)

-- Step 1: Correct tokens_total to match the user's current plan
UPDATE "profiles" SET "tokens_total" = 240000   WHERE "plan" NOT IN ('starter', 'team', 'enterprise') OR "plan" IS NULL;
UPDATE "profiles" SET "tokens_total" = 2400000  WHERE "plan" = 'starter';
UPDATE "profiles" SET "tokens_total" = 4800000  WHERE "plan" = 'team';

-- Step 2: Zero out tokens_remaining for any user whose balance exceeded their plan total
UPDATE "profiles" SET "tokens_remaining" = 0 WHERE "tokens_remaining" > "tokens_total";
