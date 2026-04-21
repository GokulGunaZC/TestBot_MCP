-- Drop old test list tables (already dropped via Supabase MCP, guards ensure idempotency)
DROP TABLE IF EXISTS "test_list_items" CASCADE;
DROP TABLE IF EXISTS "test_lists" CASCADE;

-- import_sessions: one per Excel upload
CREATE TABLE IF NOT EXISTS "import_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"original_filename" text NOT NULL,
	"file_storage_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"test_case_count" integer DEFAULT 0,
	"groovy_file_count" integer DEFAULT 0,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

-- imported_test_cases: rows from the Excel sheet
CREATE TABLE IF NOT EXISTS "imported_test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"tc_id" text NOT NULL,
	"active" text,
	"functional_area" text,
	"scenario" text,
	"description" text,
	"environment_name" text,
	"ndc_version" text,
	"pcc" text,
	"raw_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);

-- generated_groovy_files: OpenAI-generated Katalon Groovy classes
CREATE TABLE IF NOT EXISTS "generated_groovy_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"class_name" text NOT NULL,
	"api_type" text NOT NULL,
	"groovy_content" text NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now()
);

-- Foreign keys
DO $$ BEGIN
 ALTER TABLE "import_sessions" ADD CONSTRAINT "import_sessions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "imported_test_cases" ADD CONSTRAINT "imported_test_cases_import_id_import_sessions_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."import_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "generated_groovy_files" ADD CONSTRAINT "generated_groovy_files_import_id_import_sessions_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."import_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "import_sessions_user_id_idx" ON "import_sessions" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "imported_test_cases_import_id_idx" ON "imported_test_cases" USING btree ("import_id");
CREATE INDEX IF NOT EXISTS "generated_groovy_files_import_id_idx" ON "generated_groovy_files" USING btree ("import_id");
