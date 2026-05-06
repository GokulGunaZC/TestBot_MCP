import { z } from 'zod'
import { logBlockedRequest } from './security-logger'

const MAX_TESTS_PER_RUN = parseInt(process.env.MAX_TESTS_PER_RUN ?? '50', 10)
const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS ?? '40000', 10)
const MAX_ARTIFACT_SIZE_BYTES = parseInt(process.env.MAX_ARTIFACT_SIZE_BYTES ?? '52428800', 10)
const MAX_FAILURES_PER_ANALYSIS = parseInt(process.env.MAX_FAILURES_PER_ANALYSIS ?? '8', 10)

export interface ValidationError {
  error: 'INVALID_INPUT_LIMIT'
  field: string
  limit: number | string
  received?: number | string
}

function reject(field: string, limit: number | string, received?: number | string): ValidationError {
  return { error: 'INVALID_INPUT_LIMIT', field, limit, received }
}

// ── generate-tests ────────────────────────────────────────────────────
export const generateTestsSchema = z.object({
  api_key: z.string().min(1),
  context: z.unknown().optional(),
  testType: z.enum(['frontend', 'backend', 'both']).optional(),
  prd: z.string().max(MAX_PROMPT_CHARS).optional(),
  parsedPRD: z.unknown().optional(),
  explorationArtifact: z.unknown().optional(),
  roles: z.array(z.unknown()).optional(),
  projectInfo: z.unknown().optional(),
  // Optional per-agent scoping. Route-level validation does the known-name
  // check; here we just let the shape through so a bad list doesn't 422 with
  // a confusing "INVALID_INPUT_LIMIT" when the real intent is a 400
  // INVALID_AGENTS / EMPTY_AGENTS from the route.
  agents: z.array(z.string()).optional(),
  options: z
    .object({
      minGeneratedTests: z
        .number()
        .max(MAX_TESTS_PER_RUN)
        .optional(),
    })
    .passthrough()
    .optional(),
})

export function validateGenerateTests(body: unknown): ValidationError | null {
  const result = generateTestsSchema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue.path.join('.') || 'body'
    return reject(field, MAX_PROMPT_CHARS, undefined)
  }

  const parsed = result.data
  if (parsed.prd && parsed.prd.length > MAX_PROMPT_CHARS) {
    return reject('prd', MAX_PROMPT_CHARS, parsed.prd.length)
  }
  if (parsed.options?.minGeneratedTests && parsed.options.minGeneratedTests > MAX_TESTS_PER_RUN) {
    return reject('options.minGeneratedTests', MAX_TESTS_PER_RUN, parsed.options.minGeneratedTests)
  }

  return null
}

// ── analyze-failures ──────────────────────────────────────────────────
export function validateAnalyzeFailures(
  body: unknown,
  userId?: string,
  endpoint?: string
): ValidationError | null {
  const parsed = body as { failures?: unknown[] }
  if (!Array.isArray(parsed?.failures)) return null

  if (parsed.failures.length > MAX_FAILURES_PER_ANALYSIS) {
    logBlockedRequest({
      type: 'INVALID_INPUT_LIMIT',
      user_id: userId,
      reason: `failures array exceeds max (${parsed.failures.length} > ${MAX_FAILURES_PER_ANALYSIS})`,
      endpoint,
    })
    return reject('failures', MAX_FAILURES_PER_ANALYSIS, parsed.failures.length)
  }

  return null
}

// ── upload-artifacts ──────────────────────────────────────────────────
interface ArtifactInput {
  content?: string
  file_name?: string
}

export function validateArtifacts(
  artifacts: unknown,
  userId?: string,
  endpoint?: string
): ValidationError | null {
  if (!Array.isArray(artifacts)) return null

  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i] as ArtifactInput
    if (!artifact.content) continue

    const byteLength = Buffer.byteLength(artifact.content, 'base64')
    if (byteLength > MAX_ARTIFACT_SIZE_BYTES) {
      logBlockedRequest({
        type: 'INVALID_INPUT_LIMIT',
        user_id: userId,
        reason: `Artifact[${i}] size ${byteLength} exceeds ${MAX_ARTIFACT_SIZE_BYTES} bytes`,
        endpoint,
        metadata: { fileName: artifact.file_name, byteLength },
      })
      return reject(`artifacts[${i}].content`, `${MAX_ARTIFACT_SIZE_BYTES} bytes`, `${byteLength} bytes`)
    }
  }

  return null
}

// ── test-runs/ingest ──────────────────────────────────────────────────
export function validateTestRunIngest(
  body: unknown,
  userId?: string,
  endpoint?: string
): ValidationError | null {
  const parsed = body as { report?: { tests?: unknown[] } }
  if (!parsed?.report?.tests) return null

  if (!Array.isArray(parsed.report.tests)) return null

  if (parsed.report.tests.length > MAX_TESTS_PER_RUN * 10) {
    logBlockedRequest({
      type: 'INVALID_INPUT_LIMIT',
      user_id: userId,
      reason: `report.tests array too large (${parsed.report.tests.length})`,
      endpoint,
    })
    return reject('report.tests', MAX_TESTS_PER_RUN * 10, parsed.report.tests.length)
  }

  return null
}
