// Single source of truth for OpenAI per-token pricing. Used by:
//   - tokens.ts        → recordTokenUsage() snapshots these into token_ledger
//   - ai-guard.ts      → recordAiCall() computes cost_usd for telemetry
//
// Update this table when OpenAI changes prices. Old token_ledger rows are
// unaffected — they snapshot the rate that was in effect at write time.
//
// Pricing has TWO axes:
//   1. Short-context vs long-context — long-context tier kicks in once the
//      input exceeds LONG_CONTEXT_THRESHOLD_TOKENS. Some models have a single
//      tier; their `long` field is null.
//   2. Fresh input vs cached input — cached prompt tokens (prefix cache hits)
//      are billed at a discount. Models without prompt caching have
//      `cachedInputUsdPerToken: null`.

export type RateTier = {
  inputUsdPerToken: number
  cachedInputUsdPerToken: number | null
  outputUsdPerToken: number
}

export type ModelRate = {
  short: RateTier
  long: RateTier | null
}

const PER_MILLION = 1_000_000

// OpenAI prices "long context" once the input is at or above this threshold.
// Source: OpenAI pricing page (200K input tokens marks the boundary).
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000

// Per-1M-token prices in USD. Source: OpenAI pricing page (verified 2026-05).
//
//                          short ctx                                   long ctx
//   model              input  cached_in  output            input  cached_in  output
//   gpt-5.5            5.00     0.50     30.00            10.00    1.00      45.00
//   gpt-5.5-pro       30.00      -      180.00            60.00     -       270.00
//   gpt-5.4            2.50     0.25     15.00             5.00    0.50      22.50
//   gpt-5.4-mini       0.75     0.075     4.50              -       -          -
//   gpt-5.4-nano       0.20     0.02      1.25              -       -          -
//   gpt-5.4-pro       30.00      -      180.00            60.00     -       270.00
export const MODEL_RATES: Record<string, ModelRate> = {
  'gpt-5.5': {
    short: {
      inputUsdPerToken:        5.00  / PER_MILLION,
      cachedInputUsdPerToken:  0.50  / PER_MILLION,
      outputUsdPerToken:       30.00 / PER_MILLION,
    },
    long: {
      inputUsdPerToken:        10.00 / PER_MILLION,
      cachedInputUsdPerToken:  1.00  / PER_MILLION,
      outputUsdPerToken:       45.00 / PER_MILLION,
    },
  },
  'gpt-5.5-pro': {
    short: {
      inputUsdPerToken:        30.00  / PER_MILLION,
      cachedInputUsdPerToken:  null,
      outputUsdPerToken:       180.00 / PER_MILLION,
    },
    long: {
      inputUsdPerToken:        60.00  / PER_MILLION,
      cachedInputUsdPerToken:  null,
      outputUsdPerToken:       270.00 / PER_MILLION,
    },
  },
  'gpt-5.4': {
    short: {
      inputUsdPerToken:        2.50  / PER_MILLION,
      cachedInputUsdPerToken:  0.25  / PER_MILLION,
      outputUsdPerToken:       15.00 / PER_MILLION,
    },
    long: {
      inputUsdPerToken:        5.00  / PER_MILLION,
      cachedInputUsdPerToken:  0.50  / PER_MILLION,
      outputUsdPerToken:       22.50 / PER_MILLION,
    },
  },
  'gpt-5.4-mini': {
    short: {
      inputUsdPerToken:        0.75   / PER_MILLION,
      cachedInputUsdPerToken:  0.075  / PER_MILLION,
      outputUsdPerToken:       4.50   / PER_MILLION,
    },
    long: null,
  },
  'gpt-5.4-nano': {
    short: {
      inputUsdPerToken:        0.20  / PER_MILLION,
      cachedInputUsdPerToken:  0.02  / PER_MILLION,
      outputUsdPerToken:       1.25  / PER_MILLION,
    },
    long: null,
  },
  'gpt-5.4-pro': {
    short: {
      inputUsdPerToken:        30.00  / PER_MILLION,
      cachedInputUsdPerToken:  null,
      outputUsdPerToken:       180.00 / PER_MILLION,
    },
    long: {
      inputUsdPerToken:        60.00  / PER_MILLION,
      cachedInputUsdPerToken:  null,
      outputUsdPerToken:       270.00 / PER_MILLION,
    },
  },
}

// Last-resort model name when neither the OpenAI response nor OPENAI_MODEL
// is available. Kept here so changing the codebase default is a one-file
// edit, not a grep-and-replace across every recordTokenUsage call site.
const FALLBACK_MODEL = 'gpt-5.4-mini'

/**
 * Resolve which model string to record on a token-ledger entry.
 *
 *   1. The model the API call actually returned (`claimedModel`) — most
 *      accurate. OpenAI echoes the resolved model on every response.
 *   2. The configured default (`process.env.OPENAI_MODEL`) — what we asked
 *      for, when the response didn't carry it (errors, fallbacks).
 *   3. `FALLBACK_MODEL` — only when env is unset. Should never normally
 *      reach the ledger; kept as a safety net so cost rows don't have NULL
 *      models.
 *
 * Use this everywhere you'd otherwise write
 *   `model: claimed || 'gpt-X.Y'`
 * — that pattern lies in two ways: it ignores OPENAI_MODEL and bakes the
 * default into many files at once.
 */
export function resolveModel(claimedModel: string | null | undefined): string {
  if (claimedModel && claimedModel.trim()) return claimedModel
  const envModel = process.env.OPENAI_MODEL?.trim()
  if (envModel) return envModel
  return FALLBACK_MODEL
}

/**
 * Resolve the per-token rate tier for a model. Picks the long-context tier
 * automatically when `tokensInput` crosses LONG_CONTEXT_THRESHOLD_TOKENS and
 * the model publishes a long-context band; otherwise falls back to short.
 */
export function getModelRate(
  model: string | null | undefined,
  opts: { tokensInput?: number; useLongContext?: boolean } = {},
): RateTier {
  const entry = (model && MODEL_RATES[model]) || MODEL_RATES[FALLBACK_MODEL]
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
