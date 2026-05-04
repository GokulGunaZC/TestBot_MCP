-- Migration: 0011_token_ledger
-- Append-only audit log of every token movement (debit per AI call, credit per
-- top-up). `balance_after` is the running balance at insert time, so
-- `profiles.tokens_remaining` becomes a cache derivable from this table.
--
-- Rate columns are SNAPSHOTTED at write time. OpenAI changes prices; old rows
-- must remain reproducible. Do not recompute cost from a global rate table on
-- read.

CREATE TABLE IF NOT EXISTS "token_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"endpoint" text,
	"agent" text,
	"model" text,
	"tokens_input" bigint DEFAULT 0 NOT NULL,
	"tokens_output" bigint DEFAULT 0 NOT NULL,
	"tokens_total" bigint DEFAULT 0 NOT NULL,
	"tokens_delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"input_rate_usd" numeric(16, 12),
	"output_rate_usd" numeric(16, 12),
	"cost_input_usd" numeric(12, 8),
	"cost_output_usd" numeric(12, 8),
	"cost_usd" numeric(12, 8),
	"reference_type" text,
	"reference_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_ledger_entry_type_check" CHECK (entry_type IN ('debit','credit')),
	CONSTRAINT "token_ledger_agent_check" CHECK (
		agent IS NULL OR agent IN (
			'smoke','frontend','api','workflow','error','expansion',
			'planner','parse_prd','analyze_failures'
		)
	)
);

DO $$ BEGIN
 ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "token_ledger_user_created_idx" ON "token_ledger" USING btree ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "token_ledger_user_agent_idx"   ON "token_ledger" USING btree ("user_id", "agent");
CREATE INDEX IF NOT EXISTS "token_ledger_reference_idx"    ON "token_ledger" USING btree ("reference_type", "reference_id");
