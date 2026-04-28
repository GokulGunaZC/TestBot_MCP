export interface User {
  id: string
  email: string
  password_hash: string
  created_at: string
}

export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  company: string | null
  plan: 'free' | 'starter' | 'team' | 'enterprise'
  credits_remaining: number
  credits_total: number
  tokens_remaining: number
  tokens_total: number
  onboarding_completed: boolean
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  subscription_status: string | null
  created_at: string
  updated_at: string
}

export interface ApiKey {
  id: string
  user_id: string
  name: string
  key_prefix: string
  key_hash: string
  last_used_at: string | null
  expires_at: string | null
  is_active: boolean
  created_at: string
}

export interface PipelineError {
  kind?: 'pipeline'
  stage?: string
  reason?: string | null
  stderr?: string | null
  stdout?: string | null
  firstSpecPreview?: { file: string; lines: string } | null
  generatedSpecCount?: number
  qualityAuditErrors?: string[] | null
  errorCode?: string | null
  userFacingMessage?: string | null
}

export type FailureVerdict = 'test_is_wrong' | 'app_is_wrong' | 'environment' | 'ambiguous' | 'flake'
export type FailureVerdictSource = 'classifier' | 'ai' | 'user_override'

export interface TestFailure {
  id: string
  test_name: string
  test_file: string | null
  tier: string | null
  verdict: FailureVerdict
  verdict_source: FailureVerdictSource
  verdict_confidence: number | null
  fix_target: string | null
  reason: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suggested_patch: any | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evidence: any | null
  cluster_id: string | null
  user_override: FailureVerdict | null
  user_override_at: string | null
  created_at: string | null
}

export interface TestRun {
  id: string
  user_id: string
  creation_name: string
  status: 'running' | 'passed' | 'failed' | 'error'
  total_tests: number
  passed_tests: number
  failed_tests: number
  skipped_tests: number
  backend_pass_rate: number | null
  frontend_pass_rate: number | null
  duration_ms: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report_json: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ai_analysis: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coverage_metrics: any | null
  tier_results?: Record<string, { passed: number; failed: number; blocked: number; skipped: number; total: number }> | null
  pipeline_error?: PipelineError | null
  test_failures?: TestFailure[] | null
  framework: string | null
  source: 'mcp' | 'api' | 'dashboard'
  created_at: string
  updated_at: string
  run_id?: string | null
  current_phase?: string | null
  error_code?: string | null
  is_live?: boolean
}

export interface TestList {
  id: string
  user_id: string
  name: string
  description: string | null
  test_count: number
  last_run_at: string | null
  created_at: string
  updated_at: string
}

export interface TestListItem {
  id: string
  list_id: string
  test_run_id: string | null
  test_name: string
  test_config: Record<string, unknown> | null
  created_at: string
}

export interface MCPTelemetryEvent {
  id: string
  user_id: string
  api_key_id: string | null
  source: string
  tool_name: string
  event_type: string
  run_id: string | null
  phase: string | null
  status: string | null
  success: boolean | null
  error_code: string | null
  reason: string | null
  message: string | null
  duration_ms: number | null
  metadata: Record<string, unknown> | null
  occurred_at: string | null
  created_at: string | null
}
