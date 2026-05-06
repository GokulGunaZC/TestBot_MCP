/**
 * Shared plan-schema types for the P1.5 frontend/backend planner pass.
 *
 * The planner runs ONCE before the per-agent fan-out (smoke/frontend/api/
 * workflow/error) and produces a `GenerationPlan` that every downstream
 * agent consumes as a scoped "slice". This eliminates the 5× duplicate
 * "what's worth testing" reasoning across agents and gives the dashboard a
 * denominator (`plannedTests`) for partial-run progress.
 *
 * Contract:
 *   - FrontendPlan / BackendPlan are LLM-produced, hallucination-filtered
 *     against ctx.pages / ctx.apiEndpoints, and capped to keep prompts
 *     bounded.
 *   - `GenerationPlan` is what ends up cached in `generation_plans` and
 *     sent back to the MCP. The MCP then projects per-agent slices from it.
 *   - Version bumps require a migration plan — increment CURRENT_PLAN_VERSION
 *     and fix up the /api/generate-tests endpoint's `planVersion` check.
 */

export interface PageTestPlan {
  path: string;
  role: 'public' | 'authed' | 'admin' | null;
  criticalFlows: string[];
  assertions: string[];
  acIds: string[];
}

export interface WorkflowTestPlan {
  name: string;
  steps: string[];
  acIds: string[];
}

export interface EndpointTestPlan {
  method: string;
  path: string;
  authRequired: boolean;
  happyPathCases: string[];
  errorCases: string[];
  acIds: string[];
}

export interface ApiFlowPlan {
  name: string;
  steps: Array<{ method: string; path: string; rationale: string }>;
  acIds: string[];
}

export interface FrontendPlan {
  pages: PageTestPlan[];
  workflows: WorkflowTestPlan[];
  smokeTargets: string[];
  plannedTests: number;
}

export interface BackendPlan {
  endpoints: EndpointTestPlan[];
  apiFlows: ApiFlowPlan[];
  plannedTests: number;
}

export interface PlanWarning {
  kind: 'dropped_hallucination' | 'truncated' | 'empty_context' | 'fallback';
  detail: string;
}

export interface GenerationPlan {
  planVersion: 1;
  planHash: string;
  frontendPlan: FrontendPlan | null;
  backendPlan: BackendPlan | null;
  totalPlannedTests: number;
  warnings: PlanWarning[];
  generatedAt: string;
}

export const CURRENT_PLAN_VERSION = 1 as const;
