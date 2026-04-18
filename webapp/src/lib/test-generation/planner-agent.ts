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

import type { AgentPlan } from './agent-dispatcher'
import type {
  AgentName,
  CapturedContext,
  ExplorationArtifact,
  ParsedPRD,
  ProjectInfo,
  GenerationOptions,
} from './types'

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
