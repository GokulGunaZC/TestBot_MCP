import { DEFAULT_OPENAI_MODEL } from './model-defaults'

// Single source of truth for OpenAI per-token pricing. Used by:
//   - tokens.ts        → recordTokenUsage() snapshots these into token_ledger
//   - ai-guard.ts      → recordAiCall() computes cost_usd for telemetry
//
// Update this table when OpenAI changes prices. Old token_ledger rows are
// unaffected — they snapshot the rate that was in effect at write time.
//
// If a model used at runtime is NOT in this table, getModelRate() throws
// rather than silently billing at the wrong rate. Add the model here first.

export type RateTier = {
  inputUsdPerToken: number
  cachedInputUsdPerToken: number | null
  outputUsdPerToken: number
}

export type ModelRate = {
  short: RateTier
  long: RateTier | null  // null = no separate long-context tier
}

const PER_MILLION = 1_000_000

// OpenAI prices "long context" once the input is at or above this threshold.
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000

// Per-1M-token prices in USD. Source: OpenAI pricing page (verified 2026-05).
//
//                          short ctx                                   long ctx
//   model              input  cached_in  output            input  cached_in  output
// ── gpt-5.x flagship ────────────────────────────────────────────────────────────
//   gpt-5.5            5.00     0.50     30.00            10.00    1.00      45.00
//   gpt-5.5-mini       5.00     0.50     30.00            10.00    1.00      45.00
//   gpt-5.5-pro       30.00      -      180.00            60.00     -       270.00
//   gpt-5.4            2.50     0.25     15.00             5.00    0.50      22.50
//   gpt-5.4-mini       0.75    0.075      4.50              -       -          -
//   gpt-5.4-nano       0.20     0.02      1.25              -       -          -
//   gpt-5.4-pro       30.00      -      180.00            60.00     -       270.00
// ── gpt-5.x non-flagship ────────────────────────────────────────────────────────
//   gpt-5.2            1.75    0.175     14.00              -       -          -
//   gpt-5.2-pro       21.00      -      168.00              -       -          -
//   gpt-5.1            1.25    0.125     10.00              -       -          -
//   gpt-5              1.25    0.125     10.00              -       -          -
//   gpt-5-mini         0.25    0.025      2.00              -       -          -
//   gpt-5-nano         0.05    0.005      0.40              -       -          -
//   gpt-5-pro         15.00      -      120.00              -       -          -
// ── gpt-4.1 family ──────────────────────────────────────────────────────────────
//   gpt-4.1            2.00     0.50      8.00              -       -          -
//   gpt-4.1-mini       0.40     0.10      1.60              -       -          -
//   gpt-4.1-nano       0.10    0.025      0.40              -       -          -
// ── gpt-4o family ───────────────────────────────────────────────────────────────
//   gpt-4o             2.50     1.25     10.00              -       -          -
//   gpt-4o-mini        0.15    0.075      0.60              -       -          -
// ── o-series reasoning ──────────────────────────────────────────────────────────
//   o4-mini            1.10    0.275      4.40              -       -          -
//   o3                 2.00     0.50      8.00              -       -          -
//   o3-mini            1.10     0.55      4.40              -       -          -
//   o3-pro            20.00      -       80.00              -       -          -
//   o1                15.00     7.50     60.00              -       -          -
//   o1-mini            1.10     0.55      4.40              -       -          -
//   o1-pro           150.00      -      600.00              -       -          -
export const MODEL_RATES: Record<string, ModelRate> = {
  // ── gpt-5.x flagship (with long-context tiers) ───────────────────────────
  'gpt-5.5': {
    short: { inputUsdPerToken:  5.00 / PER_MILLION, cachedInputUsdPerToken:  0.50 / PER_MILLION, outputUsdPerToken: 30.00 / PER_MILLION },
    long:  { inputUsdPerToken: 10.00 / PER_MILLION, cachedInputUsdPerToken:  1.00 / PER_MILLION, outputUsdPerToken: 45.00 / PER_MILLION },
  },
  'gpt-5.5-mini': {
    // Priced conservatively at the gpt-5.5 tier until a separate mini rate is published.
    short: { inputUsdPerToken:  5.00 / PER_MILLION, cachedInputUsdPerToken:  0.50 / PER_MILLION, outputUsdPerToken: 30.00 / PER_MILLION },
    long:  { inputUsdPerToken: 10.00 / PER_MILLION, cachedInputUsdPerToken:  1.00 / PER_MILLION, outputUsdPerToken: 45.00 / PER_MILLION },
  },
  'gpt-5.5-pro': {
    short: { inputUsdPerToken: 30.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 180.00 / PER_MILLION },
    long:  { inputUsdPerToken: 60.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 270.00 / PER_MILLION },
  },
  'gpt-5.4': {
    short: { inputUsdPerToken:  2.50 / PER_MILLION, cachedInputUsdPerToken:  0.25 / PER_MILLION, outputUsdPerToken: 15.00 / PER_MILLION },
    long:  { inputUsdPerToken:  5.00 / PER_MILLION, cachedInputUsdPerToken:  0.50 / PER_MILLION, outputUsdPerToken: 22.50 / PER_MILLION },
  },
  'gpt-5.4-mini': {
    short: { inputUsdPerToken:  0.75  / PER_MILLION, cachedInputUsdPerToken: 0.075 / PER_MILLION, outputUsdPerToken:  4.50 / PER_MILLION },
    long:  null,
  },
  'gpt-5.4-nano': {
    short: { inputUsdPerToken:  0.20  / PER_MILLION, cachedInputUsdPerToken: 0.02  / PER_MILLION, outputUsdPerToken:  1.25 / PER_MILLION },
    long:  null,
  },
  'gpt-5.4-pro': {
    short: { inputUsdPerToken: 30.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 180.00 / PER_MILLION },
    long:  { inputUsdPerToken: 60.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 270.00 / PER_MILLION },
  },

  // ── gpt-5.x non-flagship ─────────────────────────────────────────────────
  'gpt-5.2': {
    short: { inputUsdPerToken:  1.75  / PER_MILLION, cachedInputUsdPerToken: 0.175 / PER_MILLION, outputUsdPerToken: 14.00 / PER_MILLION },
    long:  null,
  },
  'gpt-5.2-pro': {
    short: { inputUsdPerToken: 21.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 168.00 / PER_MILLION },
    long:  null,
  },
  'gpt-5.1': {
    short: { inputUsdPerToken:  1.25  / PER_MILLION, cachedInputUsdPerToken: 0.125 / PER_MILLION, outputUsdPerToken: 10.00 / PER_MILLION },
    long:  null,
  },
  'gpt-5': {
    short: { inputUsdPerToken:  1.25  / PER_MILLION, cachedInputUsdPerToken: 0.125 / PER_MILLION, outputUsdPerToken: 10.00 / PER_MILLION },
    long:  null,
  },
  'gpt-5-mini': {
    short: { inputUsdPerToken:  0.25  / PER_MILLION, cachedInputUsdPerToken: 0.025 / PER_MILLION, outputUsdPerToken:  2.00 / PER_MILLION },
    long:  null,
  },
  'gpt-5-nano': {
    short: { inputUsdPerToken:  0.05  / PER_MILLION, cachedInputUsdPerToken: 0.005 / PER_MILLION, outputUsdPerToken:  0.40 / PER_MILLION },
    long:  null,
  },
  'gpt-5-pro': {
    short: { inputUsdPerToken: 15.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 120.00 / PER_MILLION },
    long:  null,
  },

  // ── gpt-4.1 family ───────────────────────────────────────────────────────
  'gpt-4.1': {
    short: { inputUsdPerToken:  2.00  / PER_MILLION, cachedInputUsdPerToken: 0.50  / PER_MILLION, outputUsdPerToken:  8.00 / PER_MILLION },
    long:  null,
  },
  'gpt-4.1-mini': {
    short: { inputUsdPerToken:  0.40  / PER_MILLION, cachedInputUsdPerToken: 0.10  / PER_MILLION, outputUsdPerToken:  1.60 / PER_MILLION },
    long:  null,
  },
  'gpt-4.1-nano': {
    short: { inputUsdPerToken:  0.10  / PER_MILLION, cachedInputUsdPerToken: 0.025 / PER_MILLION, outputUsdPerToken:  0.40 / PER_MILLION },
    long:  null,
  },

  // ── gpt-4o family ────────────────────────────────────────────────────────
  'gpt-4o': {
    short: { inputUsdPerToken:  2.50  / PER_MILLION, cachedInputUsdPerToken: 1.25  / PER_MILLION, outputUsdPerToken: 10.00 / PER_MILLION },
    long:  null,
  },
  'gpt-4o-mini': {
    short: { inputUsdPerToken:  0.15  / PER_MILLION, cachedInputUsdPerToken: 0.075 / PER_MILLION, outputUsdPerToken:  0.60 / PER_MILLION },
    long:  null,
  },

  // ── o-series reasoning models ────────────────────────────────────────────
  'o4-mini': {
    short: { inputUsdPerToken:  1.10  / PER_MILLION, cachedInputUsdPerToken: 0.275 / PER_MILLION, outputUsdPerToken:  4.40 / PER_MILLION },
    long:  null,
  },
  'o3': {
    short: { inputUsdPerToken:  2.00  / PER_MILLION, cachedInputUsdPerToken: 0.50  / PER_MILLION, outputUsdPerToken:  8.00 / PER_MILLION },
    long:  null,
  },
  'o3-mini': {
    short: { inputUsdPerToken:  1.10  / PER_MILLION, cachedInputUsdPerToken: 0.55  / PER_MILLION, outputUsdPerToken:  4.40 / PER_MILLION },
    long:  null,
  },
  'o3-pro': {
    short: { inputUsdPerToken: 20.00 / PER_MILLION, cachedInputUsdPerToken: null,                outputUsdPerToken: 80.00 / PER_MILLION },
    long:  null,
  },
  'o1': {
    short: { inputUsdPerToken: 15.00 / PER_MILLION, cachedInputUsdPerToken: 7.50  / PER_MILLION, outputUsdPerToken: 60.00 / PER_MILLION },
    long:  null,
  },
  'o1-mini': {
    short: { inputUsdPerToken:  1.10  / PER_MILLION, cachedInputUsdPerToken: 0.55  / PER_MILLION, outputUsdPerToken:  4.40 / PER_MILLION },
    long:  null,
  },
  'o1-pro': {
    short: { inputUsdPerToken: 150.00 / PER_MILLION, cachedInputUsdPerToken: null,               outputUsdPerToken: 600.00 / PER_MILLION },
    long:  null,
  },
}

/**
 * Resolve which model string to record on a token-ledger entry.
 *
 *   1. The model the API call actually returned (`claimedModel`) — most
 *      accurate. OpenAI echoes the resolved model on every response.
 *   2. The configured default (`process.env.OPENAI_MODEL`) — what we asked
 *      for, when the response didn't carry it (errors, fallbacks).
 *
 * Throws if neither is available — that is a deployment configuration error
 * (OPENAI_MODEL must always be set).
 */
export function resolveModel(claimedModel: string | null | undefined): string {
  if (claimedModel && claimedModel.trim()) return claimedModel.trim()
  const envModel = process.env.OPENAI_MODEL?.trim()
  if (envModel) return envModel
  return DEFAULT_OPENAI_MODEL
}

/**
 * Resolve the per-token rate tier for a model. Picks the long-context tier
 * automatically when `tokensInput` crosses LONG_CONTEXT_THRESHOLD_TOKENS and
 * the model publishes a long-context band; otherwise uses the short tier.
 *
 * Throws if the model is not in MODEL_RATES — add it to the table above.
 */
export function getModelRate(
  model: string | null | undefined,
  opts: { tokensInput?: number; useLongContext?: boolean } = {},
): RateTier {
  const entry = model ? MODEL_RATES[model] : undefined
  if (!entry) {
    throw new Error(
      `Unknown model "${model}" — add it to MODEL_RATES in src/lib/pricing.ts before using it.`
    )
  }
  const wantsLong =
    opts.useLongContext === true ||
    (opts.tokensInput !== undefined && opts.tokensInput >= LONG_CONTEXT_THRESHOLD_TOKENS)
  if (wantsLong && entry.long) return entry.long
  return entry.short
}

/**
 * Compute USD cost for a billable call. `tokensCachedInput` is optional —
 * those tokens are billed at the cached-input rate (when the model
 * publishes one); the rest of `tokensInput` is billed as fresh.
 *
 * Returns the rate tier that was used so callers can snapshot it into the
 * token_ledger (`input_rate_usd`, `output_rate_usd`).
 */
export function computeCost(params: {
  model: string | null | undefined
  tokensInput: number
  tokensOutput: number
  tokensCachedInput?: number
  useLongContext?: boolean
}): {
  costInputUsd: number
  costCachedInputUsd: number
  costOutputUsd: number
  costUsd: number
  rate: RateTier
} {
  const rate = getModelRate(params.model, {
    tokensInput: params.tokensInput,
    useLongContext: params.useLongContext,
  })
  const tokensCached = Math.max(0, Math.min(params.tokensCachedInput ?? 0, params.tokensInput))
  const tokensFresh  = Math.max(0, params.tokensInput - tokensCached)

  // If the model has no cached-input rate, charge cached tokens at fresh rate.
  const cachedRate = rate.cachedInputUsdPerToken ?? rate.inputUsdPerToken

  const costInputUsd       = tokensFresh  * rate.inputUsdPerToken
  const costCachedInputUsd = tokensCached * cachedRate
  const costOutputUsd      = params.tokensOutput * rate.outputUsdPerToken
  const total              = costInputUsd + costCachedInputUsd + costOutputUsd

  return {
    costInputUsd:       parseFloat(costInputUsd.toFixed(8)),
    costCachedInputUsd: parseFloat(costCachedInputUsd.toFixed(8)),
    costOutputUsd:      parseFloat(costOutputUsd.toFixed(8)),
    costUsd:            parseFloat(total.toFixed(8)),
    rate,
  }
}
