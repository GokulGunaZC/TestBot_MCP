-- Migration: 0012_payments
-- One row per Stripe payment (or manual grant). The token grant for a payment
-- lives as a `credit` entry in `token_ledger` with reference_type='stripe_payment'
-- and reference_id=payments.id, so payment ↔ ledger join is a single index lookup.

CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"provider_payment_id" text,
	"provider_customer_id" text,
	"provider_session_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text NOT NULL,
	"plan" text,
	"tokens_granted" bigint DEFAULT 0 NOT NULL,
	"billing_period_start" timestamp with time zone,
	"billing_period_end" timestamp with time zone,
	"invoice_url" text,
	"raw_event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_check" CHECK (provider IN ('stripe','manual')),
	CONSTRAINT "payments_status_check"   CHECK (status IN ('pending','succeeded','failed','refunded'))
);

DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "payments_user_created_idx" ON "payments" USING btree ("user_id", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "payments_provider_payment_id_idx"
	ON "payments" USING btree ("provider_payment_id")
	WHERE "provider_payment_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" USING btree ("status");
