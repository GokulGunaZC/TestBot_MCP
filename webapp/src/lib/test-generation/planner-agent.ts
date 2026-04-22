/**
 * Planner agent — opt-in LLM-driven replacement for `planAgents()` rule-based
 * routing in `agent-dispatcher.ts`. Disabled by default; enable with
 *   HEALIX_PLANNER_AGENT=1
 *
 * The planner looks at the same inputs (parsedPRD, explorationArtifact, apiOnly,
 * context shape) and returns an `AgentPlan` — same contract as the rule-based
 * planner. When the environment flag is off, this function is never called and
 * the rule-based plan wins.
 *
 * We gate this behind a flag because:
 *   1. The rule-based planner is deterministic and good enough for v1.
 *   2. An LLM call here adds ~1–2s of latency to every generation.
 *   3. We want to measure whether a planner-decided ordering/selection actually
 *      produces higher-quality suites before making it the default.
 */

import { OpenAIClient } from './openai-client'
import type { AgentPlan } from './agent-dispatcher'
import type {
  AgentName,
  CapturedContext,
  ExplorationArtifact,
  ParsedPRD,
  ProjectInfo,
  GenerationOptions,
} from './types'
import type {
  FrontendPlan,
  BackendPlan,
  PageTestPlan,
  WorkflowTestPlan,
  EndpointTestPlan,
  ApiFlowPlan,
  PlanWarning,
} from './plan-schema'

export function isPlannerAgentEnabled(): boolean {
  return process.env.HEALIX_PLANNER_AGENT === '1'
}

export interface PlannerInput {
  testType: 'frontend' | 'backend' | 'both'
  projectInfo?: ProjectInfo
  context?: CapturedContext
  parsedPRD?: ParsedPRD | null
  explorationArtifact?: ExplorationArtifact | null
  options?: GenerationOptions
}

/**
 * Placeholder implementation — currently mirrors the rule-based plan. Once we
 * flip `HEALIX_PLANNER_AGENT=1` in staging and compare outputs, we'll replace
 * this body with a structured OpenAI function-call that returns
 * `{ agents: AgentName[], reason: string, apiOnly: boolean }` directly.
 */
export async function runPlannerAgent(_input: PlannerInput): Promise<AgentPlan | null> {
  if (!isPlannerAgentEnabled()) return null
  // TODO: call OpenAI with a structured-output schema and return the plan.
  // For now return null so the dispatcher falls back to the rule-based planner.
  const _agents: AgentName[] = []
  void _agents
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// P1.5 — Frontend / Backend planner pass
//
// One gpt-5.4-mini call per axis (frontend, backend) BEFORE the per-agent fan-out.
// The MCP pipeline-worker calls this via /api/generate-tests/plan so every
// subsequent per-agent call ships with a scoped slice ("ONLY these targets"),
// eliminating duplicate "what's worth testing" reasoning.
//
// Hallucination filter is mandatory: the LLM sometimes invents plausible-
// looking pages/endpoints that don't exist in the repo. We cross-check against
// ctx.context?.pages and ctx.context?.apiEndpoints and drop anything unknown,
// pushing a `dropped_hallucination` warning so the dashboard can surface it.
// ────────────────────────────────────────────────────────────────────────────

const PLANNER_TIMEOUT_MS = 30_000
const PAGE_CAP = 60
const ENDPOINT_CAP = 80

export interface PlanContext {
  context?: CapturedContext
  prdContent?: string
  parsedPRD?: ParsedPRD | null
  explorationArtifact?: ExplorationArtifact | null
  projectInfo?: ProjectInfo
  roles?: Array<{ name: string }>
  options?: GenerationOptions
}

export interface PlannerTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface FrontendPlanResult {
  plan: FrontendPlan
  warnings: PlanWarning[]
  tokenUsage: PlannerTokenUsage
}

export interface BackendPlanResult {
  plan: BackendPlan
  warnings: PlanWarning[]
  tokenUsage: PlannerTokenUsage
}

function buildClient(): OpenAIClient | null {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  return new OpenAIClient({
    apiKey,
    model: 'gpt-5.4-mini',
    temperature: 0.1,
    timeout: PLANNER_TIMEOUT_MS,
  })
}

function sliceContextForPrompt(ctx: CapturedContext): {
  pages: Array<{ path: string; description?: string }>
  endpoints: Array<{ method: string; path: string; authRequired?: boolean }>
  workflows: Array<{ name: string; steps?: string[] } | string>
  errorScenarios: Array<{ scenario: string; trigger: string; expectedError: string }>
} {
  return {
    pages: (ctx.pages || []).slice(0, PAGE_CAP).map((p) => ({
      path: p.path,
      description: p.description,
    })),
    endpoints: (ctx.apiEndpoints || []).slice(0, ENDPOINT_CAP).map((e) => ({
      method: e.method,
      path: e.path,
      authRequired: e.authRequired ?? e.requiresAuth ?? false,
    })),
    workflows: (ctx.workflows || []).slice(0, 20),
    errorScenarios: (ctx.errorScenarios || []).slice(0, 20),
  }
}

// Strip a fenced ```json ... ``` wrapper if the model returned one despite
// the "no prose, no code" instruction.
function extractJsonBlock(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1].trim()
  return trimmed
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(extractJsonBlock(text))
  } catch {
    return null
  }
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

function normalizePageTestPlan(entry: Record<string, unknown>): PageTestPlan | null {
  const path = typeof entry.path === 'string' ? entry.path.trim() : ''
  if (!path) return null
  const rawRole = typeof entry.role === 'string' ? entry.role.toLowerCase() : ''
  const role: PageTestPlan['role'] =
    rawRole === 'public' || rawRole === 'authed' || rawRole === 'admin' ? rawRole : null
  return {
    path,
    role,
    criticalFlows: toStringArray(entry.criticalFlows),
    assertions: toStringArray(entry.assertions),
    acIds: toStringArray(entry.acIds),
  }
}

function normalizeWorkflowPlan(entry: Record<string, unknown>): WorkflowTestPlan | null {
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (!name) return null
  return {
    name,
    steps: toStringArray(entry.steps),
    acIds: toStringArray(entry.acIds),
  }
}

function normalizeEndpointPlan(entry: Record<string, unknown>): EndpointTestPlan | null {
  const method = typeof entry.method === 'string' ? entry.method.trim().toUpperCase() : ''
  const path = typeof entry.path === 'string' ? entry.path.trim() : ''
  if (!method || !path) return null
  return {
    method,
    path,
    authRequired: entry.authRequired === true,
    happyPathCases: toStringArray(entry.happyPathCases),
    errorCases: toStringArray(entry.errorCases),
    acIds: toStringArray(entry.acIds),
  }
}

function normalizeApiFlowPlan(entry: Record<string, unknown>): ApiFlowPlan | null {
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (!name) return null
  const rawSteps = Array.isArray(entry.steps) ? (entry.steps as unknown[]) : []
  const steps = rawSteps
    .map((s): ApiFlowPlan['steps'][number] | null => {
      if (!s || typeof s !== 'object') return null
      const step = s as Record<string, unknown>
      const method = typeof step.method === 'string' ? step.method.trim().toUpperCase() : ''
      const path = typeof step.path === 'string' ? step.path.trim() : ''
      const rationale = typeof step.rationale === 'string' ? step.rationale : ''
      if (!method || !path) return null
      return { method, path, rationale }
    })
    .filter((x): x is ApiFlowPlan['steps'][number] => x !== null)
  return { name, steps, acIds: toStringArray(entry.acIds) }
}

function truncateWithWarning<T>(
  arr: T[],
  cap: number,
  kind: string,
  warnings: PlanWarning[],
): T[] {
  if (arr.length <= cap) return arr
  warnings.push({ kind: 'truncated', detail: `${kind}: ${arr.length}→${cap}` })
  return arr.slice(0, cap)
}

function normalizePath(p: string): string {
  return p.trim().toLowerCase()
}

function countFrontendTests(plan: FrontendPlan): number {
  // Rough heuristic: one test per criticalFlow, plus one per smokeTarget,
  // plus one per workflow. Agents may produce more or fewer, but this gives
  // the dashboard a reasonable denominator.
  const pageTests = plan.pages.reduce((acc, p) => acc + Math.max(1, p.criticalFlows.length), 0)
  const workflowTests = plan.workflows.length
  const smokeTests = plan.smokeTargets.length
  return pageTests + workflowTests + smokeTests
}

function countBackendTests(plan: BackendPlan): number {
  const endpointTests = plan.endpoints.reduce(
    (acc, e) => acc + Math.max(1, e.happyPathCases.length) + e.errorCases.length,
    0,
  )
  const flowTests = plan.apiFlows.length
  return endpointTests + flowTests
}

function hasEmptyContext(ctx: PlanContext): boolean {
  const pageCount = ctx.context?.pages?.length ?? 0
  const endpointCount = ctx.context?.apiEndpoints?.length ?? 0
  const hasPrd = !!(ctx.prdContent && ctx.prdContent.trim().length > 0)
  return pageCount === 0 && endpointCount === 0 && !hasPrd
}

/**
 * Ask gpt-5.4-mini for a structured frontend plan. The response MUST be a JSON
 * object — we instruct "no prose, no code" and strip any ```json fences
 * defensively. Hallucinated page paths (not in ctx.context.pages) are
 * dropped with a `dropped_hallucination` warning.
 */
export async function planFrontend(ctx: PlanContext): Promise<FrontendPlanResult> {
  const warnings: PlanWarning[] = []

  const zeroUsage: PlannerTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  if (hasEmptyContext(ctx)) {
    warnings.push({ kind: 'empty_context', detail: 'no pages/endpoints/prd' })
    return {
      plan: { pages: [], workflows: [], smokeTargets: [], plannedTests: 0 },
      warnings,
      tokenUsage: zeroUsage,
    }
  }

  const capturedContext = ctx.context || {}
  const sliced = sliceContextForPrompt(capturedContext)
  if ((capturedContext.pages?.length ?? 0) > PAGE_CAP) {
    warnings.push({
      kind: 'truncated',
      detail: `pages: ${capturedContext.pages?.length}→${PAGE_CAP}`,
    })
  }

  const client = buildClient()
  if (!client) {
    warnings.push({ kind: 'fallback', detail: 'OPENAI_API_KEY missing — planner skipped' })
    return {
      plan: { pages: [], workflows: [], smokeTargets: [], plannedTests: 0 },
      warnings,
      tokenUsage: zeroUsage,
    }
  }

  const system = [
    'You are the Healix frontend test planner.',
    'List pages, workflows, and smoke targets worth testing for this app.',
    'Return ONLY a JSON object matching the schema below. No prose. No code.',
    'Schema: { "pages": PageTestPlan[], "workflows": WorkflowTestPlan[], "smokeTargets": string[] }',
    '  PageTestPlan = { path: string, role: "public"|"authed"|"admin"|null, criticalFlows: string[], assertions: string[], acIds: string[] }',
    '  WorkflowTestPlan = { name: string, steps: string[], acIds: string[] }',
    'Only use `path` values that exist in the provided `pages` list. Never invent paths.',
    'Keep acIds scoped to the AC ids present in the parsedPRD when provided; otherwise [].',
  ].join('\n')

  const user = [
    'PROJECT:',
    JSON.stringify(ctx.projectInfo || {}),
    '',
    'PAGES (authoritative):',
    JSON.stringify(sliced.pages),
    '',
    'WORKFLOWS (observed):',
    JSON.stringify(sliced.workflows),
    '',
    'PRD (truncated):',
    (ctx.prdContent || '').slice(0, 4000),
    '',
    'PARSED_PRD:',
    JSON.stringify(ctx.parsedPRD || null).slice(0, 4000),
  ].join('\n')

  let rawText = ''
  let callUsage: PlannerTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  try {
    const result = await client.callOpenAI([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])
    rawText = result.text
    callUsage = { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens }
  } catch (err) {
    // Let the caller decide fallback semantics — planner errors bubble up.
    throw err
  }

  const parsed = safeParseJson(rawText) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') {
    warnings.push({ kind: 'fallback', detail: 'planner returned non-JSON output' })
    return {
      plan: { pages: [], workflows: [], smokeTargets: [], plannedTests: 0 },
      warnings,
      tokenUsage: callUsage,
    }
  }

  const rawPages = Array.isArray(parsed.pages) ? (parsed.pages as unknown[]) : []
  const rawWorkflows = Array.isArray(parsed.workflows) ? (parsed.workflows as unknown[]) : []
  const rawSmoke = toStringArray(parsed.smokeTargets)

  const validPaths = new Set(
    (capturedContext.pages || []).map((p) => normalizePath(p.path || '')).filter(Boolean),
  )

  const normalizedPages: PageTestPlan[] = []
  for (const entry of rawPages) {
    if (!entry || typeof entry !== 'object') continue
    const norm = normalizePageTestPlan(entry as Record<string, unknown>)
    if (!norm) continue
    if (validPaths.size > 0 && !validPaths.has(normalizePath(norm.path))) {
      warnings.push({
        kind: 'dropped_hallucination',
        detail: `page ${norm.path}`,
      })
      continue
    }
    normalizedPages.push(norm)
  }

  const normalizedWorkflows: WorkflowTestPlan[] = []
  for (const entry of rawWorkflows) {
    if (!entry || typeof entry !== 'object') continue
    const norm = normalizeWorkflowPlan(entry as Record<string, unknown>)
    if (norm) normalizedWorkflows.push(norm)
  }

  const cappedPages = truncateWithWarning(normalizedPages, PAGE_CAP, 'pages', warnings)

  const plan: FrontendPlan = {
    pages: cappedPages,
    workflows: normalizedWorkflows,
    smokeTargets: rawSmoke,
    plannedTests: 0,
  }
  plan.plannedTests = countFrontendTests(plan)

  return { plan, warnings, tokenUsage: callUsage }
}

/**
 * Ask gpt-5.4-mini for a structured backend plan. Hallucinated endpoint paths
 * (method+path not present in ctx.context.apiEndpoints) are dropped.
 */
export async function planBackend(ctx: PlanContext): Promise<BackendPlanResult> {
  const warnings: PlanWarning[] = []

  const zeroUsage: PlannerTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  if (hasEmptyContext(ctx)) {
    warnings.push({ kind: 'empty_context', detail: 'no pages/endpoints/prd' })
    return {
      plan: { endpoints: [], apiFlows: [], plannedTests: 0 },
      warnings,
      tokenUsage: zeroUsage,
    }
  }

  const capturedContext = ctx.context || {}
  const sliced = sliceContextForPrompt(capturedContext)
  if ((capturedContext.apiEndpoints?.length ?? 0) > ENDPOINT_CAP) {
    warnings.push({
      kind: 'truncated',
      detail: `endpoints: ${capturedContext.apiEndpoints?.length}→${ENDPOINT_CAP}`,
    })
  }

  const client = buildClient()
  if (!client) {
    warnings.push({ kind: 'fallback', detail: 'OPENAI_API_KEY missing — planner skipped' })
    return {
      plan: { endpoints: [], apiFlows: [], plannedTests: 0 },
      warnings,
      tokenUsage: zeroUsage,
    }
  }

  const system = [
    'You are the Healix backend test planner.',
    'List endpoints and multi-step API flows worth testing for this app.',
    'Return ONLY a JSON object matching the schema below. No prose. No code.',
    'Schema: { "endpoints": EndpointTestPlan[], "apiFlows": ApiFlowPlan[] }',
    '  EndpointTestPlan = { method: string, path: string, authRequired: boolean, happyPathCases: string[], errorCases: string[], acIds: string[] }',
    '  ApiFlowPlan = { name: string, steps: Array<{method, path, rationale}>, acIds: string[] }',
    'Only use (method, path) combinations present in the provided `endpoints` list. Never invent endpoints.',
    'Keep acIds scoped to the AC ids present in the parsedPRD when provided; otherwise [].',
  ].join('\n')

  const user = [
    'PROJECT:',
    JSON.stringify(ctx.projectInfo || {}),
    '',
    'ENDPOINTS (authoritative):',
    JSON.stringify(sliced.endpoints),
    '',
    'ERROR_SCENARIOS:',
    JSON.stringify(sliced.errorScenarios),
    '',
    'PRD (truncated):',
    (ctx.prdContent || '').slice(0, 4000),
    '',
    'PARSED_PRD:',
    JSON.stringify(ctx.parsedPRD || null).slice(0, 4000),
  ].join('\n')

  let rawText = ''
  let callUsage: PlannerTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  try {
    const result = await client.callOpenAI([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ])
    rawText = result.text
    callUsage = { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens }
  } catch (err) {
    throw err
  }

  const parsed = safeParseJson(rawText) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') {
    warnings.push({ kind: 'fallback', detail: 'planner returned non-JSON output' })
    return {
      plan: { endpoints: [], apiFlows: [], plannedTests: 0 },
      warnings,
      tokenUsage: callUsage,
    }
  }

  const rawEndpoints = Array.isArray(parsed.endpoints) ? (parsed.endpoints as unknown[]) : []
  const rawFlows = Array.isArray(parsed.apiFlows) ? (parsed.apiFlows as unknown[]) : []

  const validEndpoints = new Set(
    (capturedContext.apiEndpoints || [])
      .map((e) => `${(e.method || '').toUpperCase()} ${normalizePath(e.path || '')}`)
      .filter((k) => k !== ' '),
  )

  const normalizedEndpoints: EndpointTestPlan[] = []
  for (const entry of rawEndpoints) {
    if (!entry || typeof entry !== 'object') continue
    const norm = normalizeEndpointPlan(entry as Record<string, unknown>)
    if (!norm) continue
    const key = `${norm.method} ${normalizePath(norm.path)}`
    if (validEndpoints.size > 0 && !validEndpoints.has(key)) {
      warnings.push({
        kind: 'dropped_hallucination',
        detail: `endpoint ${norm.method} ${norm.path}`,
      })
      continue
    }
    normalizedEndpoints.push(norm)
  }

  const normalizedFlows: ApiFlowPlan[] = []
  for (const entry of rawFlows) {
    if (!entry || typeof entry !== 'object') continue
    const norm = normalizeApiFlowPlan(entry as Record<string, unknown>)
    if (norm) normalizedFlows.push(norm)
  }

  const cappedEndpoints = truncateWithWarning(
    normalizedEndpoints,
    ENDPOINT_CAP,
    'endpoints',
    warnings,
  )

  const plan: BackendPlan = {
    endpoints: cappedEndpoints,
    apiFlows: normalizedFlows,
    plannedTests: 0,
  }
  plan.plannedTests = countBackendTests(plan)

  return { plan, warnings, tokenUsage: callUsage }
}
