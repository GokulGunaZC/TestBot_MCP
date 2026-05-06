-- Migration: 0002_security_rate_limiting
-- Adds revoked column to api_keys, and creates idempotency_keys, user_flags, project_usage tables

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked" boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL,
  "response_hash" text NOT NULL,
  "response_body" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idempotency_keys_key_user_idx" ON "idempotency_keys" ("idempotency_key", "user_id");
CREATE INDEX IF NOT EXISTS "idempotency_keys_created_at_idx" ON "idempotency_keys" ("created_at");

CREATE TABLE IF NOT EXISTS "user_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "reason" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "user_flags_user_id_idx" ON "user_flags" ("user_id");
CREATE INDEX IF NOT EXISTS "user_flags_type_idx" ON "user_flags" ("type");
CREATE INDEX IF NOT EXISTS "user_flags_created_at_idx" ON "user_flags" ("created_at");

CREATE TABLE IF NOT EXISTS "project_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_hash" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "last_seen_at" timestamptz DEFAULT now(),
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "project_usage_hash_idx" ON "project_usage" ("project_hash");
CREATE INDEX IF NOT EXISTS "project_usage_user_id_idx" ON "project_usage" ("user_id");
