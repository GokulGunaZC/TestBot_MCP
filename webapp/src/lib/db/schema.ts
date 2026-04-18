import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  company: text('company'),
  role: text('role').default('developer'),
  plan: text('plan').default('free'),
  creditsRemaining: integer('credits_remaining').default(100),
  creditsTotal: integer('credits_total').default(100),
  tokensRemaining: bigint('tokens_remaining', { mode: 'number' }).default(240000),
  tokensTotal: bigint('tokens_total', { mode: 'number' }).default(240000),
  onboardingCompleted: boolean('onboarding_completed').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Default Key'),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').default(true),
    revoked: boolean('revoked').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('api_keys_user_id_idx').on(table.userId), index('api_keys_key_hash_idx').on(table.keyHash)]
)

export const testRuns = pgTable(
  'test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    creationName: text('creation_name').notNull(),
    status: text('status').default('running'),
    totalTests: integer('total_tests').default(0),
    passedTests: integer('passed_tests').default(0),
    failedTests: integer('failed_tests').default(0),
    skippedTests: integer('skipped_tests').default(0),
    backendPassRate: numeric('backend_pass_rate', { precision: 5, scale: 2 }),
    frontendPassRate: numeric('frontend_pass_rate', { precision: 5, scale: 2 }),
    durationMs: integer('duration_ms'),
    reportJson: jsonb('report_json'),
    aiAnalysis: jsonb('ai_analysis'),
    coverageMetrics: jsonb('coverage_metrics'),
    framework: text('framework'),
    source: text('source').default('mcp'),
    projectPath: text('project_path'), // Local project path for artifact fallback
    currentPhase: text('current_phase'),
    currentPhaseAt: timestamp('current_phase_at', { withTimezone: true }),
    tierResults: jsonb('tier_results'),
    pipelineError: jsonb('pipeline_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('test_runs_user_id_idx').on(table.userId),
    index('test_runs_created_at_idx').on(table.createdAt),
  ]
)

export const testFailures = pgTable(
  'test_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    testName: text('test_name').notNull(),
    testFile: text('test_file'),
    tier: text('tier'),
    verdict: text('verdict').notNull(),
    verdictSource: text('verdict_source').notNull(),
    verdictConfidence: numeric('verdict_confidence', { precision: 3, scale: 2 }),
    fixTarget: text('fix_target'),
    reason: text('reason'),
    suggestedPatch: jsonb('suggested_patch'),
    evidence: jsonb('evidence'),
    clusterId: text('cluster_id'),
    userOverride: text('user_override'),
    userOverrideAt: timestamp('user_override_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('test_failures_run_idx').on(table.testRunId),
    index('test_failures_user_verdict_idx').on(table.userId, table.verdict),
    index('test_failures_cluster_idx').on(table.testRunId, table.clusterId),
  ]
)

export const mcpTelemetryEvents = pgTable(
  'mcp_telemetry_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('healix-mcp'),
    toolName: text('tool_name').notNull(),
    eventType: text('event_type').notNull(),
    runId: text('run_id'),
    phase: text('phase'),
    status: text('status'),
    success: boolean('success').default(false),
    errorCode: text('error_code'),
    reason: text('reason'),
    message: text('message'),
    durationMs: integer('duration_ms'),
    metadata: jsonb('metadata'),
    modelUsed: text('model_used'),
    tokensPrompt: integer('tokens_prompt'),
    tokensCompletion: integer('tokens_completion'),
    tokensTotal: integer('tokens_total'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    agent: text('agent'),
    latencyMs: integer('latency_ms'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('mcp_telemetry_user_id_idx').on(table.userId),
    index('mcp_telemetry_api_key_id_idx').on(table.apiKeyId),
    index('mcp_telemetry_occurred_at_idx').on(table.occurredAt),
    index('mcp_telemetry_run_id_idx').on(table.runId),
    index('mcp_telemetry_event_type_idx').on(table.eventType),
    index('mcp_telemetry_status_idx').on(table.status),
    index('mcp_telemetry_agent_idx').on(table.agent),
  ]
)

export const testLists = pgTable('test_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  testCount: integer('test_count').default(0),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const testListItems = pgTable('test_list_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  listId: uuid('list_id')
    .notNull()
    .references(() => testLists.id, { onDelete: 'cascade' }),
  testRunId: uuid('test_run_id').references(() => testRuns.id, {
    onDelete: 'set null',
  }),
  testName: text('test_name').notNull(),
  testConfig: jsonb('test_config'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const testArtifacts = pgTable(
  'test_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    testName: text('test_name').notNull(),
    artifactType: text('artifact_type').notNull(), // 'screenshot', 'video', 'trace'
    storageUrl: text('storage_url'), // Supabase Storage public URL (nullable for fallback)
    storagePath: text('storage_path'), // Path in bucket: test-artifacts/{runId}/{testName}/{type}/{filename}
    fileName: text('file_name').notNull(),
    fileSize: integer('file_size'), // bytes
    contentType: text('content_type'),
    metadata: jsonb('metadata'), // Additional info like timestamp, browser, viewport
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('test_artifacts_test_run_id_idx').on(table.testRunId),
    index('test_artifacts_artifact_type_idx').on(table.artifactType),
  ]
)

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    responseHash: text('response_hash').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idempotency_keys_key_user_idx').on(table.idempotencyKey, table.userId),
    index('idempotency_keys_created_at_idx').on(table.createdAt),
  ]
)

export const userFlags = pgTable(
  'user_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    reason: text('reason').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('user_flags_user_id_idx').on(table.userId),
    index('user_flags_type_idx').on(table.type),
    index('user_flags_created_at_idx').on(table.createdAt),
  ]
)

export const projectUsage = pgTable(
  'project_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectHash: text('project_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('project_usage_hash_idx').on(table.projectHash),
    index('project_usage_user_id_idx').on(table.userId),
  ]
)
