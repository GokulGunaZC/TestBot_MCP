/**
 * Agent dispatcher — thin façade over `OpenAITestGenerator` that:
 *
 *   1. Derives a rule-based plan of which agents to run from the request
 *      (smoke / frontend / api / workflow / error) so the generator no longer
 *      hard-codes that decision.
 *   2. Invokes the generator, streaming per-agent telemetry back to the caller
 *      via `onAgentComplete`.
 *   3. Leaves room for an opt-in `planner-agent.ts` (set `HEALIX_PLANNER_AGENT=1`)
 *      that lets an LLM override the rule-based plan when the inputs are thin.
 *
 * The underlying generator is unchanged — this keeps the surface area small and
 * the refactor incremental. When we split the prompt builders into individual
 * `agents/*.ts` files, this dispatcher is the integration point that picks them.
 */

import { OpenAITestGenerator, OpenAITestGeneratorConfig } from './openai-generator'
import { isPlannerAgentEnabled, runPlannerAgent } from './planner-agent'
import type {
  AgentName,
  AgentCompleteHook,
  GenerateTestsParams,
  GeneratedTestFile,
  GenerationMeta,
  GenerationQuality,
  ProjectInfo,
  CapturedContext,
  ParsedPRD,
  ExplorationArtifact,
} from './types'

export interface AgentPlan {
  agents: AgentName[]
  reason: string
  apiOnly: boolean
}

export function planAgents(input: {
  testType: 'frontend' | 'backend' | 'both'
  projectInfo?: ProjectInfo
  context?: CapturedContext
  parsedPRD?: ParsedPRD | null
  explorationArtifact?: ExplorationArtifact | null
  options?: GenerateTestsParams['options']
}): AgentPlan {
  const projectInfo = input.projectInfo || {}
  const context = input.context || {}
  const options = input.options || {}
  const apiOnly = projectInfo.apiOnly === true
  const testType = apiOnly ? 'backend' : input.testType

  const agents: AgentName[] = []
  const why: string[] = []

  if (apiOnly) {
    agents.push('api')
    why.push('api-only repo → single API flow agent')
    if (options.includeErrorStates && (context.errorScenarios?.length ?? 0) > 0) {
      agents.push('error')
      why.push('error scenarios present')
    }
    return { agents, reason: why.join('; '), apiOnly: true }
  }

  if (options.includeSmoke !== false) {
    agents.push('smoke')
    why.push('smoke on by default')
  }

  if (testType === 'frontend' || testType === 'both') {
    if ((context.pages?.length ?? 0) > 0 || context.navigationGraph) {
      agents.push('frontend')
      why.push('pages detected')
    } else if (input.parsedPRD || input.explorationArtifact) {
      agents.push('frontend')
      why.push('PRD/exploration present — frontend runs even without static pages')
    }
  }

  if (testType === 'backend' || testType === 'both') {
    if ((context.apiEndpoints?.length ?? 0) > 0 || input.parsedPRD) {
      agents.push('api')
      why.push('api endpoints or PRD present')
    }
  }

  if (options.includeWorkflows !== false && (context.workflows?.length ?? 0) > 0) {
    agents.push('workflow')
    why.push('workflows detected')
  }

  if (options.includeErrorStates && (context.errorScenarios?.length ?? 0) > 0) {
    agents.push('error')
    why.push('error scenarios present')
  }

  if (agents.length === 0) {
    agents.push('smoke')
    why.push('fallback: empty plan → smoke')
  }

  return { agents, reason: why.join('; '), apiOnly: false }
}

export interface DispatchParams extends GenerateTestsParams {
  generatorConfig?: OpenAITestGeneratorConfig
  onAgentComplete?: AgentCompleteHook
  // Optional per-agent scoping. When provided, only agents in the set run.
  // When undefined, the rule-based / LLM plan chooses. The actual filtering
  // happens inside OpenAITestGenerator (see P1-a2); this type lets callers
  // (the /api/generate-tests route) thread the value through today.
  agentsAllowlist?: Set<AgentName>
  // P1.5 — optional per-agent plan slice. When present, the generator folds
  // it into the agent-level prompt as an "ONLY generate tests for these
  // targets" preamble. When absent, the generator falls back to its
  // open-ended prompt (existing behavior).
  agentPlanSlice?: Record<string, unknown>
  // Caller-supplied abort signal. The /api/generate-tests route fires this
  // the moment the user's balance hits 0 (after any agent's debit lands), so
  // in-flight OpenAI calls die instead of running for free on our dime.
  abortSignal?: AbortSignal
}

export interface DispatchResult {
  files: GeneratedTestFile[]
  summary: {
    totalFiles: number
    files: GeneratedTestFile[]
    generationMeta: GenerationMeta | null
    generationQuality: GenerationQuality | null
    tokenUsage: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
      modelUsed: string | null
    }
    byType: Record<string, number>
    agentRuns: Array<import('./types').AgentRunRecord>
  }
  plan: AgentPlan
}

export async function dispatchAgents(params: DispatchParams): Promise<DispatchResult> {
  const rulePlan = planAgents({
    testType: params.testType || 'both',
    projectInfo: params.projectInfo,
    context: params.context,
    parsedPRD: params.parsedPRD,
    explorationArtifact: params.explorationArtifact,
    options: params.options,
  })

  // Opt-in LLM planner (HEALIX_PLANNER_AGENT=1). Falls back to rule-based plan
  // if disabled or if the planner returns null (current placeholder behavior).
  const llmPlan = isPlannerAgentEnabled()
    ? await runPlannerAgent({
        testType: params.testType || 'both',
        projectInfo: params.projectInfo,
        context: params.context,
        parsedPRD: params.parsedPRD,
        explorationArtifact: params.explorationArtifact,
        options: params.options,
      })
    : null
  const plan = llmPlan ?? rulePlan

  const generator = new OpenAITestGenerator(params.generatorConfig)
  generator.setAbortSignal(params.abortSignal)
  const files = await generator.generateTests({
    context: params.context,
    prd: params.prd,
    parsedPRD: params.parsedPRD,
    explorationArtifact: params.explorationArtifact,
    roles: params.roles,
    testType: params.testType,
    projectInfo: params.projectInfo,
    options: params.options,
    onAgentComplete: params.onAgentComplete,
    agentsAllowlist: params.agentsAllowlist,
    agentPlanSlice: params.agentPlanSlice,
  })

  const summary = generator.getSummary()
  return { files, summary, plan }
}
